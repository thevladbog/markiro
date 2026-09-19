# Импорт шаблона этикетки из JSON и экспорт в JSON — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Диалог «Импорт кода» принимает JSON модели шаблона (тот же документ, что
`POST /label-templates`), редактор умеет скачать `{ name, purpose, spec }` в JSON, а
ZPL-импортёр перестаёт терять число строк из `^FB`.

**Architecture:** Разбор JSON живёт в `@markiro/domain` рядом с ZPL/TSPL-импортёрами и
использует ту же `parseLabelTemplate`, что API; для предупреждений о лишних свойствах
в `model.ts` появляется строгий близнец схемы из тех же shape-ов. В админке логика
«текст + формат → результат или ошибка» вынесена в чистый модуль `import-analysis.ts`,
панель полей — в отдельный компонент, диалог остаётся оболочкой. Экспорт — третья
кнопка «Скачать» через `download.ts`.

**Tech Stack:** TypeScript strict, zod 4.4.3, React 19 + react-i18next, Vitest +
Testing Library (jsdom), `@markiro/ui` (Radix Select/Modal), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-18-label-editor-json-import-design.md`

## Global Constraints

- TypeScript strict с `noUncheckedIndexedAccess` и `exactOptionalPropertyTypes`: не
  маскировать неопределённость `any`, `as` и `!`; необязательные ключи добавлять
  условным spread'ом, а не `key: undefined`. Только `import type` для типов.
- Тексты UI — через i18n, ключи добавляются в **оба** файла `apps/admin/src/i18n/ru.json`
  и `en.json`: тест `apps/admin/test/i18n.test.tsx` требует одинаковые наборы ключей.
- Компоненты и токены — из `@markiro/ui`; доступность: `aria-label`, роли, `role="alert"`
  для ошибок, `aria-live="polite"` для сводки — как в текущем диалоге.
- API и OpenAPI не меняются. После рефакторинга `model.ts` должен остаться зелёным
  `apps/api/test/label-templates-openapi.test.ts` (схема генерируется из
  `labelTemplateSpecSchema`).
- Выдача ZPL/TSPL-импортёров для однострочных исходников не меняется байт в байт:
  регрессия — `apps/admin/test/label-samples.test.ts` (30 образцов) и
  `packages/domain/test/labels-import.test.ts`.
- `@markiro/domain` и `@markiro/ui` экспортируют `dist`: после **каждой** правки в
  `packages/domain` перед тестами админки выполнять
  `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build`.
- Окружение этого worktree: зависимости ставятся **один раз вне песочницы**
  (`CI=true pnpm install --frozen-lockfile`, затем `rm -rf .pnpm-store`), после чего в
  песочнице каждая команда pnpm идёт с `--config.verifyDepsBeforeRun=false` — иначе pnpm
  заводит локальный store и сносит `node_modules` (см. память проекта, ловушка 20).
  Перед первой задачей также `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/ui build`.
- Коммиты: conventional prefix (`feat`, `fix`, `refactor`, `test`, `docs`), в конце тела
  строка `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Стейджить только
  перечисленные пути.
- Пути ошибок и предупреждений — через точку, как их даёт `parseLabelTemplate`:
  `elements.3.maxlines`, для корня — `comment`.

---

## File Structure

| Файл                                                               | Ответственность                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `packages/domain/src/labels/import.ts` (изм.)                      | `LabelImportFormat`, расширенный `LabelImportWarningCode`, `line: number \| null`                  |
| `packages/domain/src/labels/zpl-import.ts` (изм.)                  | второй параметр `^FB` → `maxLines`                                                                 |
| `packages/domain/src/labels/model.ts` (изм.)                       | shape-ы элементов + строгий близнец `labelTemplateSpecStrictSchema`                                |
| `packages/domain/src/labels/json-import.ts` (новый)                | `parseLabelJson`: лимиты, `JSON.parse`, обёртка, предупреждения, `parseLabelTemplate`              |
| `packages/domain/src/index.ts` (изм.)                              | экспорт новых типов и функции                                                                      |
| `packages/domain/test/labels-import.test.ts` (изм.)                | тесты `^FB`                                                                                        |
| `packages/domain/test/labels-json-import.test.ts` (новый)          | тесты строгого близнеца и `parseLabelJson`                                                         |
| `apps/admin/src/pages/labels/editor/import-analysis.ts` (новый)    | `analyzeImport`: формат → `parseLabelCode`/`parseLabelJson` → `fitSpecElements` → результат/ошибка |
| `apps/admin/src/pages/labels/editor/ImportFieldsPanel.tsx` (новый) | панель «Шаблонные поля» с синтаксисом `placeholder` / `json`                                       |
| `apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx` (изм.)   | оболочка: селекты, textarea, сводка, ошибки, предупреждения                                        |
| `apps/admin/src/pages/labels/editor/download.ts` (изм.)            | `buildJsonBlob`                                                                                    |
| `apps/admin/src/pages/labels/editor/index.tsx` (изм.)              | `onReplace(analysis)`, подстановка имени, кнопка «Скачать JSON»                                    |
| `apps/admin/src/pages/labels/editor/editor.css` (изм.)             | список ошибок                                                                                      |
| `apps/admin/src/i18n/ru.json`, `en.json` (изм.)                    | новые ключи, текст пустого состояния                                                               |
| `apps/admin/test/labels-import-analysis.test.ts` (новый)           | тесты `analyzeImport`                                                                              |
| `apps/admin/test/labels-import-fields-panel.test.tsx` (новый)      | тесты панели полей                                                                                 |
| `apps/admin/test/labels-editor.test.tsx` (изм.)                    | JSON в диалоге, имя, пустое состояние, «Скачать JSON», круговой прогон                             |

---

### Task 1: Тип предупреждения, `LabelImportFormat` и число строк из `^FB`

**Files:**

- Modify: `packages/domain/src/labels/import.ts:10-18`
- Modify: `packages/domain/src/labels/zpl-import.ts` (интерфейс `ZplState`, константы, `case "FB"`, `finalizeField`)
- Modify: `packages/domain/src/index.ts:123-129`
- Test: `packages/domain/test/labels-import.test.ts`

**Interfaces:**

- Produces:
  - `export type LabelImportFormat = "zpl" | "tspl" | "json"` (import.ts)
  - `export type LabelImportWarningCode = "UNSUPPORTED_COMMAND" | "UNKNOWN_PROPERTY" | "PURPOSE_MISMATCH"`
  - `LabelImportWarning.line: number | null` (остальные поля прежние: `code`, `message`, `source`)
  - ZPL-импорт: `^FB<w>,<n>,…` с целым `n >= 2` даёт элементу `maxLines: min(n, 16)`.

- [ ] **Step 1: Написать падающие тесты для `^FB`**

В `packages/domain/test/labels-import.test.ts` заменить первую строку импорта из
`../src/index.js`:

```ts
import {
  generateZpl,
  LABEL_FIELDS,
  MAX_LABEL_CODE_BYTES,
  parseLabelTemplate,
  sampleLabelData,
} from "../src/index.js";
```

и добавить внутрь `describe("ZPL subset", …)` (после теста
`"keeps fields across physical lines and accepts regex-special ^FH indicators"`):

```ts
it("reads the ^FB line count into maxLines and leaves single-line fields untouched", () => {
  const result = parseZplLabel(
    [
      "^XA",
      "^PW464",
      "^LL320",
      "^FO16,16^A0N,28,28^FB432,3,0,L,0^FD{{product.printName}}^FS",
      "^FO16,120^A0N,28,28^FB432,1,0,C,0^FDОдна строка^FS",
      "^FO16,160^A0N,28,28^FB432^FDБез счётчика^FS",
      "^FO16,200^A0N,28,28^FB432,99,0,L,0^FDПотолок^FS",
      "^FO16,240^A0N,28,28^FB432,2.5,0,L,0^FDДробь^FS",
      "^XZ",
    ].join("\n"),
    203,
  );

  const [wrapped, single, bare, capped, fractional] = result.spec.elements;
  expect(wrapped).toMatchObject({ kind: "field", field: "product.printName", maxLines: 3 });
  expect(single).not.toHaveProperty("maxLines");
  expect(bare).not.toHaveProperty("maxLines");
  expect(capped).toMatchObject({ kind: "text", text: "Потолок", maxLines: 16 });
  expect(fractional).not.toHaveProperty("maxLines");
});

it("round-trips maxLines through generateZpl", async () => {
  const spec = parseLabelTemplate({
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    elements: [
      {
        kind: "field",
        id: "name",
        xMm: 2,
        yMm: 2,
        field: "product.printName",
        fontSizePt: 10,
        maxWidthMm: 54,
        maxLines: 3,
      },
    ],
  });
  // Latin-only data keeps the emitter on the native ^A0N/^FB path: a
  // Cyrillic value is rasterized into ^GFA, which the importer reports
  // as unsupported.
  const zpl = await generateZpl(spec, { ...sampleLabelData(), "product.printName": "Plain name" });
  expect(zpl).toMatch(/\^FB432,3,0,[LCR],0/);

  const back = parseZplLabel(zpl, 203);
  expect(back.spec.elements[0]).toMatchObject({ kind: "text", text: "Plain name", maxLines: 3 });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/labels-import.test.ts`
Expected: FAIL — `expected { … } to match object { maxLines: 3 }` в обоих новых тестах;
остальные тесты файла зелёные.

- [ ] **Step 3: Расширить типы в `import.ts`**

Заменить в `packages/domain/src/labels/import.ts` блок от `export type LabelCodeLanguage`
до конца `interface LabelImportWarning` на:

```ts
export type LabelCodeLanguage = "zpl" | "tspl";
/**
 * What the import dialog offers: the two printer languages, parsed from
 * code, plus `json` -- the label model itself (`labelTemplateSpecSchema`),
 * pasted as the same document `POST /label-templates` accepts.
 */
export type LabelImportFormat = LabelCodeLanguage | "json";
export type LabelImportWarningCode =
  /** ZPL/TSPL: a line the parser does not understand; replacing drops it. */
  | "UNSUPPORTED_COMMAND"
  /** JSON: a property outside the label model; the schema strips it. */
  | "UNKNOWN_PROPERTY"
  /** JSON: the wrapper's `purpose` differs from the template being edited. */
  | "PURPOSE_MISMATCH";

export interface LabelImportWarning {
  code: LabelImportWarningCode;
  message: string;
  /**
   * 1-based source line for ZPL/TSPL. `null` for JSON, which has no line
   * bookkeeping after `JSON.parse`; there `source` is the dotted property
   * path (`elements.3.maxlines`) or `purpose: "pallet"`.
   */
  line: number | null;
  source: string;
}
```

В `packages/domain/src/index.ts` в блоке `export type { LabelCodeLanguage, … } from "./labels/import.js";`
добавить `LabelImportFormat,` после `LabelCodeLanguage,`.

- [ ] **Step 4: Читать второй параметр `^FB` в `zpl-import.ts`**

В интерфейсе `ZplState` после строки `maxWidthDots?: number;` добавить:

```ts
  maxLines?: number;
```

После константы `SUPPORTED` добавить:

```ts
/** `maxLines` ceiling of the label model (`wrappableTextShape` in model.ts). */
const MAX_FIELD_BLOCK_LINES = 16;
```

Заменить ветку `case "FB": { … }` на:

```ts
        case "FB": {
          if (!state) fail(line, source, "ZPL field block requires ^FO");
          const parts = args.split(",");
          const width = Number(parts[0]);
          if (!Number.isFinite(width) || width <= 0)
            fail(line, source, "invalid ZPL field block width");
          state.maxWidthDots = width;
          // ^FB's second parameter is the maximum number of lines the block
          // may wrap into -- the emitter writes `maxLines` there. Only a
          // whole number of 2+ lines changes anything: 1 is the model's own
          // default, and a missing or malformed value leaves the element
          // single-line, exactly as every import before this parameter was
          // read. Anything above the model's ceiling is clamped to it.
          const lines = Number(parts[1]);
          if (Number.isInteger(lines) && lines >= 2) {
            state.maxLines = Math.min(lines, MAX_FIELD_BLOCK_LINES);
          }
          const alignment = alignFromZpl(parts[3]?.trim());
          if (alignment) state.align = alignment;
          break;
        }
```

В `finalizeField` заменить объявление `const common = { … };` на:

```ts
const common = {
  id,
  xMm,
  yMm,
  fontSizePt: pointsFromDots(state.fontHeightDots, dpi),
  maxWidthMm: state.maxWidthDots === undefined ? undefined : dotsToMm(state.maxWidthDots, dpi),
  ...(state.maxLines === undefined ? {} : { maxLines: state.maxLines }),
};
```

- [ ] **Step 5: Прогнать тесты импорта и эмиттера**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/labels-import.test.ts test/labels-zpl.test.ts`
Expected: PASS, все тесты обоих файлов.

- [ ] **Step 6: Typecheck и lint домена**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain lint`
Expected: без ошибок.

- [ ] **Step 7: Коммит**

```bash
git add packages/domain/src/labels/import.ts packages/domain/src/labels/zpl-import.ts packages/domain/src/index.ts packages/domain/test/labels-import.test.ts
git commit -m "fix(domain): read the ^FB line count into maxLines on ZPL import

The emitter writes maxLines as ^FB's second parameter, the importer only
read the width and justification, so every imported text came back
single-line. Also widens the import warning type for the JSON importer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Строгий близнец схемы шаблона

**Files:**

- Modify: `packages/domain/src/labels/model.ts:41-197`
- Test: `packages/domain/test/labels-json-import.test.ts` (новый)

**Interfaces:**

- Produces: `export const labelTemplateSpecStrictSchema` (model.ts) — та же структура, что
  `labelTemplateSpecSchema`, но неизвестные ключи дают issue `unrecognized_keys` вместо
  отбрасывания. Без `superRefine`; только для сбора ключей, не для валидации.
- Не меняется: `labelTemplateSpecSchema`, `parseLabelTemplate`, все `Label*Element` типы.

- [ ] **Step 1: Написать падающий тест**

Создать `packages/domain/test/labels-json-import.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { labelTemplateSpecSchema, labelTemplateSpecStrictSchema } from "../src/labels/model.js";

/** The pallet 58×40 layout from the JSON-import task, exactly as the API accepts it. */
const EXAMPLE_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    {
      kind: "field",
      id: "name",
      xMm: 2,
      yMm: 2,
      field: "product.printName",
      fontSizePt: 10,
      bold: true,
      maxWidthMm: 54,
      maxLines: 3,
    },
    { kind: "line", id: "sep1", xMm: 2, yMm: 18.2, x2Mm: 56, y2Mm: 18.2, thicknessMm: 0.3 },
    {
      kind: "text",
      id: "cap-date",
      xMm: 2,
      yMm: 18.8,
      text: "Дата производства:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "text",
      id: "cap-expiry",
      xMm: 20,
      yMm: 18.8,
      text: "Годен до:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "text",
      id: "cap-qty",
      xMm: 38,
      yMm: 18.8,
      text: "Коробов:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-date",
      xMm: 2,
      yMm: 21.6,
      field: "date",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-expiry",
      xMm: 20,
      yMm: 21.6,
      field: "expiry",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-qty",
      xMm: 38,
      yMm: 20.9,
      field: "qty.boxes",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 18,
    },
    { kind: "line", id: "sep2", xMm: 2, yMm: 26.2, x2Mm: 56, y2Mm: 26.2, thicknessMm: 0.3 },
    {
      kind: "text",
      id: "cap-egais",
      xMm: 2,
      yMm: 26.8,
      text: "Код ЕГАИС:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-egais",
      xMm: 20,
      yMm: 26.8,
      field: "product.egais",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 36,
    },
    { kind: "line", id: "sep3", xMm: 2, yMm: 31.4, x2Mm: 56, y2Mm: 31.4, thicknessMm: 0.3 },
    {
      kind: "barcode",
      id: "bc-sscc",
      xMm: 9.5,
      yMm: 32,
      format: "code128",
      data: "sscc",
      sizeMm: 4.8,
      moduleWidthMm: 0.2502,
    },
    {
      kind: "field",
      id: "val-sscc",
      xMm: 2,
      yMm: 37,
      field: "sscc",
      fontSizePt: 5,
      align: "center",
      maxWidthMm: 54,
    },
  ],
};

describe("labelTemplateSpecStrictSchema", () => {
  it("accepts the same document as the lenient schema when nothing is unknown", () => {
    const strict = labelTemplateSpecStrictSchema.safeParse(EXAMPLE_SPEC);
    const lenient = labelTemplateSpecSchema.safeParse(EXAMPLE_SPEC);
    expect(strict.success).toBe(true);
    expect(lenient.success).toBe(true);
    if (strict.success && lenient.success) expect(strict.data).toEqual(lenient.data);
  });

  it("reports unknown properties at every level the lenient schema silently strips", () => {
    const input = {
      ...EXAMPLE_SPEC,
      comment: "top-level note",
      elements: [
        {
          kind: "field",
          id: "name",
          xMm: 2,
          yMm: 2,
          field: "product.printName",
          fontSizePt: 10,
          maxlines: 3,
        },
        {
          kind: "barcode",
          id: "bc",
          xMm: 2,
          yMm: 20,
          format: "code128",
          data: { literal: "123", foo: 1 },
          sizeMm: 5,
        },
      ],
    };

    const lenient = labelTemplateSpecSchema.safeParse(input);
    expect(lenient.success).toBe(true);
    if (lenient.success) {
      expect(lenient.data).not.toHaveProperty("comment");
      expect(lenient.data.elements[0]).not.toHaveProperty("maxlines");
      expect(lenient.data.elements[1]).toMatchObject({ data: { literal: "123" } });
    }

    const strict = labelTemplateSpecStrictSchema.safeParse(input);
    expect(strict.success).toBe(false);
    if (strict.success) return;
    const codes = strict.error.issues.map((issue) => issue.code);
    // Root and element: direct `unrecognized_keys`; the barcode's `data` is a
    // union, so its unknown key arrives inside an `invalid_union` issue.
    expect(codes.filter((code) => code === "unrecognized_keys")).toHaveLength(2);
    expect(codes).toContain("invalid_union");
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/labels-json-import.test.ts`
Expected: FAIL — `labelTemplateSpecStrictSchema` не экспортируется (`undefined`).

- [ ] **Step 3: Вынести shape-ы и собрать строгий близнец в `model.ts`**

Заменить в `packages/domain/src/labels/model.ts` всё от строки
`/** Shared placement fields every element carries. */` до строки
`export type LabelTemplateSpec = z.infer<typeof labelTemplateSpecSchema>;` включительно на
блок ниже. Комментарии к `wrappableTextShape`, `moduleWidthMm` и `labelTemplateSpecSchema`
переносятся дословно из текущего файла (здесь сокращены до `/* … */`, чтобы не дублировать).

```ts
/** Shared placement fields every element carries. */
const elementBaseShape = {
  id: z.string().min(1),
  xMm: z.number(),
  yMm: z.number(),
};

/* … существующий комментарий про `maxWidthMm` / `maxLines` … */
const wrappableTextShape = {
  fontSizePt: z.number().min(4).max(72),
  bold: z.boolean().optional(),
  align: alignSchema.optional(),
  maxWidthMm: z.number().positive().optional(),
  maxLines: z.number().int().min(1).max(16).optional(),
};

/*
 * Every element is declared as a SHAPE and then wrapped twice: `z.object`
 * for `labelTemplateSpecSchema` (the validator -- unknown keys are stripped,
 * exactly as the API has always behaved) and `z.strictObject` for
 * `labelTemplateSpecStrictSchema` below (unknown keys are REPORTED). Sharing
 * the shape objects is what keeps the two twins from ever drifting apart.
 */
const textElementShape = {
  kind: z.literal("text"),
  ...elementBaseShape,
  text: z.string(),
  ...wrappableTextShape,
};
const textElementSchema = z.object(textElementShape);
export type LabelTextElement = z.infer<typeof textElementSchema>;

const fieldElementShape = {
  kind: z.literal("field"),
  ...elementBaseShape,
  field: labelFieldSchema,
  /** Human-readable identity only; the barcode continues to use the original field bytes. */
  textFormat: z.literal("km_without_crypto").optional(),
  ...wrappableTextShape,
};
const fieldElementSchema = z.object(fieldElementShape);
export type LabelFieldElement = z.infer<typeof fieldElementSchema>;

const barcodeFormatSchema = z.enum(["datamatrix", "code128", "ean13", "qr"]);

/**
 * `literalData` is the `{ literal }` branch of `data`, passed in so the
 * lenient and strict twins share every other line of this shape.
 */
function barcodeElementShape(literalData: z.ZodType<{ literal: string }, { literal: string }>) {
  return {
    kind: z.literal("barcode"),
    ...elementBaseShape,
    format: barcodeFormatSchema,
    // For code128/ean13, sizeMm is the barcode height (width is derived from the
    // encoded data). For matrix codes (datamatrix/qr) it is the module square side.
    data: z.union([labelFieldSchema, literalData]),
    sizeMm: z.number().positive(),
    /* … существующий комментарий про `moduleWidthMm` … */
    moduleWidthMm: z.number().positive().optional(),
  };
}
const barcodeElementSchema = z.object(barcodeElementShape(z.object({ literal: z.string() })));
export type LabelBarcodeElement = z.infer<typeof barcodeElementSchema>;

const lineElementShape = {
  kind: z.literal("line"),
  ...elementBaseShape,
  x2Mm: z.number(),
  y2Mm: z.number(),
  thicknessMm: z.number().positive(),
};
const lineElementSchema = z.object(lineElementShape);
export type LabelLineElement = z.infer<typeof lineElementSchema>;

const boxElementShape = {
  kind: z.literal("box"),
  ...elementBaseShape,
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  thicknessMm: z.number().positive(),
};
const boxElementSchema = z.object(boxElementShape);
export type LabelBoxElement = z.infer<typeof boxElementSchema>;

const labelElementSchema = z.discriminatedUnion("kind", [
  textElementSchema,
  fieldElementSchema,
  barcodeElementSchema,
  lineElementSchema,
  boxElementSchema,
]);
export type LabelElement = z.infer<typeof labelElementSchema>;

const dpiSchema = z.union([z.literal(203), z.literal(300)]);

/** A printer resolution the emitters support. */
export type PrinterDpi = z.infer<typeof dpiSchema>;

/** The spec's own scalar fields; each twin adds its `elements`. */
const specShape = {
  widthMm: z.number().min(10).max(300),
  heightMm: z.number().min(10).max(300),
  dpi: dpiSchema,
  language: z.enum(["zpl", "tspl"]),
};

/* … существующий комментарий к `labelTemplateSpecSchema` … */
export const labelTemplateSpecSchema = z
  .object({ ...specShape, elements: z.array(labelElementSchema) })
  .superRefine((spec, ctx) => {
    const seenIds = new Set<string>();
    for (const element of spec.elements) {
      if (
        element.kind === "field" &&
        element.textFormat === "km_without_crypto" &&
        element.field !== "km.code"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "km_without_crypto requires the km.code field",
          path: ["elements"],
        });
      }
      if (seenIds.has(element.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate element id "${element.id}": every element's id must be unique within a label template`,
          path: ["elements"],
        });
      }
      seenIds.add(element.id);
    }
  });
export type LabelTemplateSpec = z.infer<typeof labelTemplateSpecSchema>;

/**
 * Strict twin of `labelTemplateSpecSchema`: the SAME shapes, but an unknown
 * property is reported as an `unrecognized_keys` issue instead of being
 * silently stripped. It exists for ONE consumer -- the JSON importer, which
 * runs it first to WARN the author about properties the lenient schema is
 * about to drop (a typo such as `maxlines` would otherwise vanish without a
 * trace). It is never the validator: `parseLabelTemplate` (lenient, with the
 * unique-id refinement) stays the single source of truth, and the API keeps
 * accepting and stripping unknown keys exactly as before.
 */
export const labelTemplateSpecStrictSchema = z.strictObject({
  ...specShape,
  elements: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject(textElementShape),
      z.strictObject(fieldElementShape),
      z.strictObject(barcodeElementShape(z.strictObject({ literal: z.string() }))),
      z.strictObject(lineElementShape),
      z.strictObject(boxElementShape),
    ]),
  ),
});
```

- [ ] **Step 4: Прогнать тесты модели и новый файл**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/labels-json-import.test.ts test/labels-model.test.ts test/labels-defaults.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, сборка домена и OpenAPI-тест API**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain lint && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/label-templates-openapi.test.ts`
Expected: PASS (схема OpenAPI не изменилась: те же shape-ы, тот же `z.object`).
Если тест падает на отсутствующем `dist` другого пакета (`/db`, `/platform-contracts`),
сначала `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/api^...'`.

- [ ] **Step 6: Коммит**

```bash
git add packages/domain/src/labels/model.ts packages/domain/test/labels-json-import.test.ts
git commit -m "refactor(domain): declare label element shapes once and add a strict schema twin

labelTemplateSpecStrictSchema reports unknown properties instead of
stripping them; the JSON importer uses it to warn before the lenient
schema drops a typo. Validation is unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `parseLabelJson`

**Files:**

- Create: `packages/domain/src/labels/json-import.ts`
- Modify: `packages/domain/src/index.ts` (после `export { parseTsplLabel } …`)
- Test: `packages/domain/test/labels-json-import.test.ts`

**Interfaces:**

- Consumes: `labelTemplateSpecStrictSchema`, `parseLabelTemplate` (Task 2); `assertImportInputLimits`,
  `MAX_LABEL_CODE_ELEMENTS`, `LabelImportResult`, `LabelImportWarning` (Task 1);
  `LabelTemplatePurpose` из `../product-labels/contracts.js` (только тип).
- Produces:

  ```ts
  export interface ParseLabelJsonOptions {
    purpose: LabelTemplatePurpose;
  }
  export interface LabelJsonImportResult extends LabelImportResult {
    name?: string;
  }
  export function parseLabelJson(
    input: string,
    options: ParseLabelJsonOptions,
  ): LabelJsonImportResult;
  ```

  Ошибки: `DomainError` с кодами `LABEL_CODE_TOO_LARGE`, `LABEL_CODE_INVALID`,
  `LABEL_CODE_LIMIT`, `LABEL_INVALID` (последняя — из `parseLabelTemplate`, `cause` =
  `Array<{ path: string; message: string }>`).

- [ ] **Step 1: Написать падающие тесты**

В `packages/domain/test/labels-json-import.test.ts` дополнить импорты:

```ts
import { DomainError } from "../src/errors.js";
import { MAX_LABEL_CODE_BYTES } from "../src/labels/import.js";
import { parseLabelJson } from "../src/labels/json-import.js";
```

и добавить в конец файла:

```ts
function thrownBy(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a DomainError");
}

describe("parseLabelJson", () => {
  it("imports a bare spec unchanged, with no warnings and no name", () => {
    const result = parseLabelJson(JSON.stringify(EXAMPLE_SPEC), { purpose: "pallet" });
    expect(result.spec).toEqual(EXAMPLE_SPEC);
    expect(result.warnings).toEqual([]);
    expect(result.sourceLineByElementId).toEqual({});
    expect(result).not.toHaveProperty("name");
  });

  it("unwraps a request body, returns its trimmed name and checks purpose against the template", () => {
    const body = { name: "  Паллета 58×40  ", purpose: "pallet", spec: EXAMPLE_SPEC };
    const matching = parseLabelJson(JSON.stringify(body), { purpose: "pallet" });
    expect(matching.name).toBe("Паллета 58×40");
    expect(matching.spec).toEqual(EXAMPLE_SPEC);
    expect(matching.warnings).toEqual([]);

    const mismatching = parseLabelJson(JSON.stringify(body), { purpose: "box" });
    expect(mismatching.warnings).toEqual([
      expect.objectContaining({
        code: "PURPOSE_MISMATCH",
        line: null,
        source: 'purpose: "pallet"',
      }),
    ]);
  });

  it("ignores the other wrapper keys silently and drops a blank or overlong name", () => {
    const fromGet = {
      id: "2b6f0c1e-0000-4000-8000-000000000001",
      name: "   ",
      purpose: "pallet",
      spec: EXAMPLE_SPEC,
      enabled: true,
      chzProductGroupCodes: [23, 33],
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    };
    const result = parseLabelJson(JSON.stringify(fromGet), { purpose: "pallet" });
    expect(result.warnings).toEqual([]);
    expect(result).not.toHaveProperty("name");

    const long = parseLabelJson(JSON.stringify({ name: "x".repeat(250), spec: EXAMPLE_SPEC }), {
      purpose: "pallet",
    });
    expect(long.name).toHaveLength(200);
  });

  it("warns about every unknown property inside spec with a dotted path and strips it", () => {
    const input = {
      ...EXAMPLE_SPEC,
      comment: "top-level note",
      elements: [
        {
          kind: "field",
          id: "name",
          xMm: 2,
          yMm: 2,
          field: "product.printName",
          fontSizePt: 10,
          maxlines: 3,
        },
        {
          kind: "barcode",
          id: "bc",
          xMm: 2,
          yMm: 20,
          format: "code128",
          data: { literal: "123", foo: 1 },
          sizeMm: 5,
        },
      ],
    };
    const result = parseLabelJson(JSON.stringify(input), { purpose: "pallet" });

    expect(result.warnings.map((warning) => warning.source).sort()).toEqual(
      ["comment", "elements.0.maxlines", "elements.1.data.foo"].sort(),
    );
    for (const warning of result.warnings) {
      expect(warning).toMatchObject({ code: "UNKNOWN_PROPERTY", line: null });
    }
    expect(result.spec).not.toHaveProperty("comment");
    expect(result.spec.elements[0]).not.toHaveProperty("maxlines");
    expect(result.spec.elements[1]).toMatchObject({ data: { literal: "123" } });
  });

  it("rejects malformed input with a blocking error", () => {
    expect(thrownBy(() => parseLabelJson("{", { purpose: "box" }))).toMatchObject({
      code: "LABEL_CODE_INVALID",
      message: expect.stringMatching(/^invalid JSON: /),
    });
    expect(thrownBy(() => parseLabelJson("[]", { purpose: "box" }))).toMatchObject({
      code: "LABEL_CODE_INVALID",
      message: "expected a label template object",
    });
    expect(thrownBy(() => parseLabelJson('{"spec": 42}', { purpose: "box" }))).toMatchObject({
      code: "LABEL_CODE_INVALID",
      message: "spec must be an object",
    });
  });

  it("enforces the shared size and element limits", () => {
    expect(
      thrownBy(() => parseLabelJson("X".repeat(MAX_LABEL_CODE_BYTES + 1), { purpose: "box" })).code,
    ).toBe("LABEL_CODE_TOO_LARGE");
    const tooMany = {
      ...EXAMPLE_SPEC,
      elements: Array.from({ length: 1001 }, (_, index) => ({
        kind: "line",
        id: `l${index}`,
        xMm: 0,
        yMm: 0,
        x2Mm: 1,
        y2Mm: 1,
        thicknessMm: 0.3,
      })),
    };
    expect(thrownBy(() => parseLabelJson(JSON.stringify(tooMany), { purpose: "box" })).code).toBe(
      "LABEL_CODE_LIMIT",
    );
  });

  it("reports schema issues with their paths, exactly like the API", () => {
    const missingFont = {
      ...EXAMPLE_SPEC,
      elements: [{ kind: "text", id: "a", xMm: 1, yMm: 1, text: "x" }],
    };
    const error = thrownBy(() => parseLabelJson(JSON.stringify(missingFont), { purpose: "box" }));
    expect(error.code).toBe("LABEL_INVALID");
    const issues = error.cause as Array<{ path: string; message: string }>;
    expect(issues.map((issue) => issue.path)).toContain("elements.0.fontSizePt");

    const duplicateIds = {
      ...EXAMPLE_SPEC,
      elements: [
        { kind: "text", id: "a", xMm: 1, yMm: 1, text: "x", fontSizePt: 6 },
        { kind: "text", id: "a", xMm: 1, yMm: 5, text: "y", fontSizePt: 6 },
      ],
    };
    const duplicate = thrownBy(() =>
      parseLabelJson(JSON.stringify(duplicateIds), { purpose: "box" }),
    );
    const duplicateIssues = duplicate.cause as Array<{ path: string; message: string }>;
    expect(duplicateIssues).toEqual([
      { path: "elements", message: expect.stringContaining('duplicate element id "a"') },
    ]);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/labels-json-import.test.ts`
Expected: FAIL — модуль `../src/labels/json-import.js` не найден.

- [ ] **Step 3: Реализовать `json-import.ts`**

Создать `packages/domain/src/labels/json-import.ts`:

```ts
/**
 * JSON import: the label model itself, pasted as the same document
 * `POST /label-templates` accepts -- either a bare spec or the request
 * body `{ name, purpose, spec }`. Validation is `parseLabelTemplate`, the
 * exact function the API runs, so the editor and the API can never disagree
 * about what a template is. What this module adds on top is what a paste
 * needs and an API call does not: the wrapper's `name` for the editor,
 * a `purpose` cross-check, and WARNINGS about properties the lenient schema
 * is about to strip silently (`labelTemplateSpecStrictSchema`).
 */
import type { z } from "zod";

import { DomainError } from "../errors.js";
import type { LabelTemplatePurpose } from "../product-labels/contracts.js";
import {
  assertImportInputLimits,
  MAX_LABEL_CODE_ELEMENTS,
  type LabelImportResult,
  type LabelImportWarning,
} from "./import.js";
import { labelTemplateSpecStrictSchema, parseLabelTemplate } from "./model.js";

export interface ParseLabelJsonOptions {
  /** Purpose of the template being edited; a wrapper's differing `purpose` is a warning. */
  purpose: LabelTemplatePurpose;
}

export interface LabelJsonImportResult extends LabelImportResult {
  /** `name` of a `{ name, purpose, spec }` wrapper: trimmed, cut to the API's limit. */
  name?: string;
}

/** `POST /label-templates` caps `name` at 200 characters (`createLabelTemplateSchema`). */
const MAX_TEMPLATE_NAME_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dotted path in the form `parseLabelTemplate` reports issues: `elements.3.maxlines`. */
function dottedPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join(".");
}

/**
 * One warning per unknown key. Issues nested inside an `invalid_union` carry
 * paths RELATIVE to that union's input (Zod finalizes them when the union
 * fails and later prefixes only the union issue itself), so the union's
 * absolute path is carried down as `prefix`. A barcode's `data` is such a
 * union: `{ literal, foo }` fails both the enum branch and the strict-object
 * branch, and the unknown `foo` lives in the second branch's issues.
 */
function collectUnknownProperties(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  prefix: ReadonlyArray<PropertyKey>,
  warnings: LabelImportWarning[],
): void {
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const source = dottedPath([...path, key]);
        warnings.push({
          code: "UNKNOWN_PROPERTY",
          line: null,
          source,
          message: `unknown property "${source}" is not part of the label model and will be dropped`,
        });
      }
    } else if (issue.code === "invalid_union") {
      for (const branch of issue.errors) collectUnknownProperties(branch, path, warnings);
    }
  }
}

export function parseLabelJson(
  input: string,
  options: ParseLabelJsonOptions,
): LabelJsonImportResult {
  assertImportInputLimits(input);

  let root: unknown;
  try {
    root = JSON.parse(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DomainError("LABEL_CODE_INVALID", `invalid JSON: ${reason}`);
  }
  if (!isPlainObject(root)) {
    throw new DomainError("LABEL_CODE_INVALID", "expected a label template object");
  }

  const warnings: LabelImportWarning[] = [];
  let candidate: Record<string, unknown> = root;
  let name: string | undefined;

  if ("spec" in root) {
    const spec = root["spec"];
    if (!isPlainObject(spec)) {
      throw new DomainError("LABEL_CODE_INVALID", "spec must be an object");
    }
    candidate = spec;
    const wrapperName = root["name"];
    if (typeof wrapperName === "string" && wrapperName.trim() !== "") {
      name = wrapperName.trim().slice(0, MAX_TEMPLATE_NAME_LENGTH);
    }
    const wrapperPurpose = root["purpose"];
    if (typeof wrapperPurpose === "string" && wrapperPurpose !== options.purpose) {
      warnings.push({
        code: "PURPOSE_MISMATCH",
        line: null,
        source: `purpose: ${JSON.stringify(wrapperPurpose)}`,
        message:
          `purpose "${wrapperPurpose}" does not match this template's purpose ` +
          `"${options.purpose}"; the layout is imported as is`,
      });
    }
    // Every other wrapper key (`id`, `enabled`, `chzProductGroupCodes`,
    // timestamps of a GET response) is ignored on purpose: the wrapper is
    // not the layout, and a pasted API response must not produce noise.
  }

  const elements = candidate["elements"];
  if (Array.isArray(elements) && elements.length > MAX_LABEL_CODE_ELEMENTS) {
    throw new DomainError(
      "LABEL_CODE_LIMIT",
      `label code exceeds ${MAX_LABEL_CODE_ELEMENTS} elements`,
    );
  }

  const strict = labelTemplateSpecStrictSchema.safeParse(candidate);
  if (!strict.success) collectUnknownProperties(strict.error.issues, [], warnings);

  const spec = parseLabelTemplate(candidate);
  return {
    spec,
    warnings,
    sourceLineByElementId: {},
    ...(name === undefined ? {} : { name }),
  };
}
```

В `packages/domain/src/index.ts` после строки
`export { parseTsplLabel } from "./labels/tspl-import.js";` добавить:

```ts
export { parseLabelJson } from "./labels/json-import.js";
export type { LabelJsonImportResult, ParseLabelJsonOptions } from "./labels/json-import.js";
```

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/labels-json-import.test.ts`
Expected: PASS, 9 тестов.

Если падает только `"warns about every unknown property…"` на пути `elements.1.data.foo`
(например, приходит `elements.1.data.elements.1.data.foo`), значит вложенные issues union-а
уже абсолютные: в `collectUnknownProperties` для ветки `invalid_union` передавать `prefix`
вместо `path`. Проверить фактическую форму `strict.error.issues` через `console.log` и
оставить тот вариант, при котором тест зелёный.

- [ ] **Step 5: Полные гейты домена**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain test && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain lint && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build`
Expected: всё зелёное; `dist` пересобран (нужен админке в следующих задачах).

- [ ] **Step 6: Коммит**

```bash
git add packages/domain/src/labels/json-import.ts packages/domain/src/index.ts packages/domain/test/labels-json-import.test.ts
git commit -m "feat(domain): parseLabelJson imports the label model as the API accepts it

Bare spec or { name, purpose, spec } body; same parseLabelTemplate as the
API; unknown properties and a purpose mismatch become warnings.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `analyzeImport` — чистая логика проверки в админке

**Files:**

- Create: `apps/admin/src/pages/labels/editor/import-analysis.ts`
- Test: `apps/admin/test/labels-import-analysis.test.ts` (новый)

**Interfaces:**

- Consumes: `parseLabelCode`, `parseLabelJson`, `DomainError`, `LabelImportFormat`,
  `LabelImportResult`, `LabelTemplatePurpose`, `PrinterDpi` из `@markiro/domain`;
  `fitSpecElements` из `../geometry.js`; `labelPreviewData`, `labelRenderOptions` из
  `../preview-data.js`.
- Produces:

  ```ts
  export interface ImportAnalysisIssue {
    path: string;
    message: string;
  }
  export type ImportAnalysisError =
    | { kind: "elementTooLarge" }
    | { kind: "message"; message: string }
    | { kind: "issues"; issues: ImportAnalysisIssue[] };
  export interface ImportAnalysis {
    result: LabelImportResult;
    adjustedIds: string[];
    name?: string;
  }
  export interface AnalyzeImportInput {
    source: string;
    format: LabelImportFormat;
    dpi: PrinterDpi;
    purpose: LabelTemplatePurpose;
  }
  export type AnalyzeImportOutcome =
    { ok: true; analysis: ImportAnalysis } | { ok: false; error: ImportAnalysisError };
  export function analyzeImport(input: AnalyzeImportInput): AnalyzeImportOutcome;
  ```

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/admin/test/labels-import-analysis.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { analyzeImport } from "../src/pages/labels/editor/import-analysis.js";

const NAME_FIELD = {
  kind: "field",
  id: "name",
  xMm: 2,
  yMm: 2,
  field: "product.printName",
  fontSizePt: 10,
  bold: true,
  maxWidthMm: 54,
  maxLines: 3,
};

/** Four elements of the pallet 58×40 layout from the JSON-import task. */
const JSON_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    NAME_FIELD,
    { kind: "line", id: "sep1", xMm: 2, yMm: 18.2, x2Mm: 56, y2Mm: 18.2, thicknessMm: 0.3 },
    {
      kind: "text",
      id: "cap-date",
      xMm: 2,
      yMm: 18.8,
      text: "Дата производства:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-date",
      xMm: 2,
      yMm: 21.6,
      field: "date",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 18,
    },
  ],
};

const ZPL = ["^XA", "^PW464", "^LL320", "^FO40,40^A0N,34,34^FDПартия^FS", "^XZ"].join("\n");

describe("analyzeImport", () => {
  it("parses JSON with the label's own dpi and language and keeps the elements", () => {
    const outcome = analyzeImport({
      source: JSON.stringify(JSON_SPEC),
      format: "json",
      dpi: 300,
      purpose: "pallet",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.result.spec).toMatchObject({ dpi: 203, language: "zpl" });
    expect(outcome.analysis.result.spec.elements.map((element) => element.id)).toEqual([
      "name",
      "sep1",
      "cap-date",
      "val-date",
    ]);
    expect(outcome.analysis.result.warnings).toEqual([]);
    expect(outcome.analysis).not.toHaveProperty("name");
  });

  it("passes a wrapper name through and reports a purpose mismatch as a warning", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({ name: "Паллета 58×40", purpose: "pallet", spec: JSON_SPEC }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.name).toBe("Паллета 58×40");
    expect(outcome.analysis.result.warnings).toEqual([
      expect.objectContaining({ code: "PURPOSE_MISMATCH", source: 'purpose: "pallet"' }),
    ]);
  });

  it("fits an element that hangs over the edge and reports its id", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({ ...JSON_SPEC, elements: [{ ...NAME_FIELD, xMm: 57 }] }),
      format: "json",
      dpi: 203,
      purpose: "pallet",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.adjustedIds).toEqual(["name"]);
  });

  it("turns schema failures into an issue list with dotted paths", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({
        ...JSON_SPEC,
        elements: [{ kind: "text", id: "a", xMm: 1, yMm: 1, text: "x" }],
      }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: "issues",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "elements.0.fontSizePt" }),
        ]),
      },
    });
  });

  it("turns a JSON syntax error and an oversized element into single messages", () => {
    const syntax = analyzeImport({ source: "{", format: "json", dpi: 203, purpose: "box" });
    expect(syntax).toEqual({
      ok: false,
      error: { kind: "message", message: expect.stringMatching(/^invalid JSON: /) },
    });

    const tooLarge = analyzeImport({
      source: JSON.stringify({
        ...JSON_SPEC,
        elements: [
          { kind: "box", id: "b", xMm: 0, yMm: 0, widthMm: 200, heightMm: 200, thicknessMm: 1 },
        ],
      }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(tooLarge).toEqual({ ok: false, error: { kind: "elementTooLarge" } });
  });

  it("still routes ZPL and TSPL through parseLabelCode with the chosen dpi", () => {
    const outcome = analyzeImport({ source: ZPL, format: "zpl", dpi: 203, purpose: "box" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.result.spec).toMatchObject({ dpi: 203, language: "zpl" });
    expect(outcome.analysis.result.spec.elements).toHaveLength(1);
    expect(outcome.analysis.result.sourceLineByElementId).toEqual({ "import-zpl-1": 4 });

    const unsupported = analyzeImport({
      source: `${ZPL.replace("^XZ", "^GFA,10,10,1,FF\n^XZ")}`,
      format: "zpl",
      dpi: 203,
      purpose: "box",
    });
    expect(unsupported.ok).toBe(true);
    if (!unsupported.ok) return;
    expect(unsupported.analysis.result.warnings).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_COMMAND", line: 5 }),
    ]);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin exec vitest run test/labels-import-analysis.test.ts`
Expected: FAIL — модуль `import-analysis.js` не найден. (Если падает с
`Cannot find module '@markiro/domain'` или без `parseLabelJson` — сначала
`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build`.)

- [ ] **Step 3: Реализовать `import-analysis.ts`**

Создать `apps/admin/src/pages/labels/editor/import-analysis.ts`:

```ts
/**
 * The import dialog's "Проверить код" step as a pure function: source text
 * plus format in, a fitted spec (or a structured error) out. No DOM and no
 * i18n -- the dialog maps `ImportAnalysisError` to copy -- so the three
 * formats' contracts are unit-tested without rendering anything.
 */
import {
  DomainError,
  parseLabelCode,
  parseLabelJson,
  type LabelImportFormat,
  type LabelImportResult,
  type LabelTemplatePurpose,
  type PrinterDpi,
} from "@markiro/domain";

import { fitSpecElements } from "../geometry.js";
import { labelPreviewData, labelRenderOptions } from "../preview-data.js";

export interface ImportAnalysisIssue {
  path: string;
  message: string;
}

export type ImportAnalysisError =
  /** An element is larger than the label itself (`fitSpecElements`). */
  | { kind: "elementTooLarge" }
  /** One blocking message: a parser error, a JSON syntax error, a limit. */
  | { kind: "message"; message: string }
  /** The spec failed the model schema: every issue with its dotted path. */
  | { kind: "issues"; issues: ImportAnalysisIssue[] };

export interface ImportAnalysis {
  result: LabelImportResult;
  adjustedIds: string[];
  /** Wrapper `name` of a JSON import; absent for ZPL/TSPL and for a bare spec. */
  name?: string;
}

export interface AnalyzeImportInput {
  source: string;
  format: LabelImportFormat;
  /** Import DPI for ZPL/TSPL; ignored for JSON, which carries its own. */
  dpi: PrinterDpi;
  purpose: LabelTemplatePurpose;
}

export type AnalyzeImportOutcome =
  { ok: true; analysis: ImportAnalysis } | { ok: false; error: ImportAnalysisError };

/** `parseLabelTemplate` puts `Array<{ path, message }>` into `DomainError.cause`. */
function isIssueList(cause: unknown): cause is ImportAnalysisIssue[] {
  return (
    Array.isArray(cause) &&
    cause.every(
      (issue: unknown) =>
        typeof issue === "object" &&
        issue !== null &&
        typeof (issue as { path?: unknown }).path === "string" &&
        typeof (issue as { message?: unknown }).message === "string",
    )
  );
}

export function analyzeImport(input: AnalyzeImportInput): AnalyzeImportOutcome {
  let parsed: LabelImportResult & { name?: string };
  try {
    parsed =
      input.format === "json"
        ? parseLabelJson(input.source, { purpose: input.purpose })
        : parseLabelCode(input.source, { language: input.format, dpi: input.dpi });
  } catch (caught) {
    if (
      caught instanceof DomainError &&
      caught.code === "LABEL_INVALID" &&
      isIssueList(caught.cause)
    ) {
      return { ok: false, error: { kind: "issues", issues: caught.cause } };
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, error: { kind: "message", message } };
  }

  const fitted = fitSpecElements(
    parsed.spec,
    labelPreviewData(input.purpose),
    labelRenderOptions(input.purpose),
  );
  if (!fitted.ok) return { ok: false, error: { kind: "elementTooLarge" } };

  const { name, ...result } = parsed;
  return {
    ok: true,
    analysis: {
      result: { ...result, spec: fitted.spec },
      adjustedIds: fitted.adjustedIds,
      ...(name === undefined ? {} : { name }),
    },
  };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin exec vitest run test/labels-import-analysis.test.ts`
Expected: PASS, 6 тестов.

- [ ] **Step 5: Коммит**

```bash
git add apps/admin/src/pages/labels/editor/import-analysis.ts apps/admin/test/labels-import-analysis.test.ts
git commit -m "feat(admin): analyzeImport — one pure check step for ZPL, TSPL and JSON imports

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Панель «Шаблонные поля» как компонент с двумя синтаксисами

**Files:**

- Create: `apps/admin/src/pages/labels/editor/ImportFieldsPanel.tsx`
- Modify: `apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx` (убрать панель и копирование)
- Modify: `apps/admin/src/i18n/ru.json:2147-2166`, `apps/admin/src/i18n/en.json:2147-2166` (ключ `fieldsHintJson`)
- Test: `apps/admin/test/labels-import-fields-panel.test.tsx` (новый)

**Interfaces:**

- Produces: `export function ImportFieldsPanel({ syntax }: { syntax: "placeholder" | "json" })`.
  В режиме `placeholder` показывает и копирует `{{product.name}}`, в режиме `json` —
  `product.name`. Тексты: `pages.labels.editor.import.fieldsHint` / `fieldsHintJson`.
- Не меняется: поведение диалога для ZPL/TSPL (все текущие тесты `labels-editor.test.tsx`).

- [ ] **Step 1: Добавить ключ `fieldsHintJson` в оба словаря**

В `apps/admin/src/i18n/ru.json` внутри `pages.labels.editor.import` после строки
`"fieldsHint": "Вставьте плейсхолдер целиком в текст или штрихкод.",` добавить:

```json
          "fieldsHintJson": "Подставьте как значение field у текста или data у штрихкода.",
```

В `apps/admin/src/i18n/en.json` после `"fieldsHint": "Insert the complete placeholder into text or barcode content.",`:

```json
          "fieldsHintJson": "Use as the field value of a text element or the data value of a barcode.",
```

- [ ] **Step 2: Написать падающий тест панели**

Создать `apps/admin/test/labels-import-fields-panel.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportFieldsPanel } from "../src/pages/labels/editor/ImportFieldsPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ImportFieldsPanel", () => {
  it("shows {{placeholders}} for code and bare field ids for JSON, copying exactly what it shows", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { rerender } = render(<ImportFieldsPanel syntax="placeholder" />);
    expect(screen.getByRole("complementary", { name: "Шаблонные поля" })).toBeDefined();
    expect(screen.getByText("{{product.printName}}")).toBeDefined();
    expect(screen.getByText("Вставьте плейсхолдер целиком в текст или штрихкод.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Копировать {{product.printName}}" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("{{product.printName}}"));
    expect(await screen.findByRole("status")).toBeDefined();

    rerender(<ImportFieldsPanel syntax="json" />);
    expect(screen.queryByText("{{product.printName}}")).toBeNull();
    expect(screen.getByText("product.printName")).toBeDefined();
    expect(
      screen.getByText("Подставьте как значение field у текста или data у штрихкода."),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Копировать product.printName" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("product.printName"));
  });

  it("reports a clipboard failure instead of pretending the copy happened", async () => {
    vi.stubGlobal("navigator", {});
    render(<ImportFieldsPanel syntax="json" />);
    fireEvent.click(screen.getByRole("button", { name: "Копировать sscc" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin exec vitest run test/labels-import-fields-panel.test.tsx`
Expected: FAIL — модуль `ImportFieldsPanel.js` не найден.

- [ ] **Step 4: Создать `ImportFieldsPanel.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { LABEL_FIELDS, type LabelField } from "@markiro/domain";
import { Button } from "@markiro/ui";

export interface ImportFieldsPanelProps {
  /**
   * `placeholder`: `{{field}}` -- the token a ZPL/TSPL payload must contain
   * in full to become a field. `json`: the bare field id -- the value of a
   * text element's `field` or a barcode's `data`.
   */
  syntax: "placeholder" | "json";
}

function fieldToken(field: LabelField, syntax: ImportFieldsPanelProps["syntax"]): string {
  return syntax === "json" ? field : `{{${field}}}`;
}

/**
 * The import dialog's reference of bindable fields with a Copy action. Copy
 * failure stays visible and the token stays selectable for manual copying.
 */
export function ImportFieldsPanel({ syntax }: ImportFieldsPanelProps) {
  const { t } = useTranslation();
  const [copiedField, setCopiedField] = useState<LabelField | null>(null);
  const [copyError, setCopyError] = useState(false);

  const rows = useMemo(
    () =>
      LABEL_FIELDS.map((field) => ({
        field,
        token: fieldToken(field, syntax),
        label: t(`pages.labels.editor.fields.${field}`),
      })),
    [syntax, t],
  );

  async function handleCopy(field: LabelField, token: string): Promise<void> {
    setCopyError(false);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(token);
      setCopiedField(field);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <aside
      className="label-editor__import-fields"
      aria-label={t("pages.labels.editor.import.fieldsTitle")}
    >
      <div className="label-editor__eyebrow">{t("pages.labels.editor.import.fieldsTitle")}</div>
      <p>
        {t(
          syntax === "json"
            ? "pages.labels.editor.import.fieldsHintJson"
            : "pages.labels.editor.import.fieldsHint",
        )}
      </p>
      {rows.map(({ field, label, token }) => (
        <div className="label-editor__import-field" key={field}>
          <div>
            <strong>{label}</strong>
            <code>{token}</code>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            aria-label={t("pages.labels.editor.import.copy", { placeholder: token })}
            onClick={() => void handleCopy(field, token)}
          >
            {t("pages.labels.editor.import.copyShort")}
          </Button>
        </div>
      ))}
      {copiedField && <div role="status">{t("pages.labels.editor.import.copied")}</div>}
      {copyError && <div role="alert">{t("pages.labels.editor.import.copyError")}</div>}
    </aside>
  );
}
```

- [ ] **Step 5: Переключить диалог на панель**

В `apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx`:

1. В импорте из `@markiro/domain` убрать `LABEL_FIELDS` и `type LabelField`; из `react`
   убрать `useMemo`. Добавить `import { ImportFieldsPanel } from "./ImportFieldsPanel.js";`.
2. Удалить константу `FIELD_COPY_KEYS`, состояния `copiedField`/`copyError` (и их сбросы
   в `useEffect`), `fieldRows` и функцию `handleCopy`.
3. Заменить весь `<aside className="label-editor__import-fields" …>…</aside>` на:

```tsx
<ImportFieldsPanel syntax="placeholder" />
```

- [ ] **Step 6: Прогнать тесты панели и редактора**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin exec vitest run test/labels-import-fields-panel.test.tsx test/labels-editor.test.tsx test/i18n.test.tsx`
Expected: PASS — панель, все тесты редактора (в том числе
`"opens a labelled import dialog with every available template field"` и
`"copies an exact field placeholder…"`), lockstep RU/EN.

- [ ] **Step 7: Коммит**

```bash
git add apps/admin/src/pages/labels/editor/ImportFieldsPanel.tsx apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/labels-import-fields-panel.test.tsx
git commit -m "refactor(admin): extract the import dialog's fields panel with a JSON syntax mode

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: JSON в диалоге импорта, подстановка имени, тексты

**Files:**

- Modify: `apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx` (полная замена)
- Modify: `apps/admin/src/pages/labels/editor/index.tsx` (импорты, `handleImportReplace`)
- Modify: `apps/admin/src/pages/labels/editor/editor.css:169-182`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/labels-editor.test.tsx`

**Interfaces:**

- Consumes: `analyzeImport`, `ImportAnalysis`, `ImportAnalysisError` (Task 4);
  `ImportFieldsPanel` (Task 5); `LabelImportFormat`, `LabelImportWarning` (Task 1).
- Produces: `ImportCodeDialogProps.onReplace: (analysis: ImportAnalysis) => void`
  (вместо `LabelImportResult`); в `index.tsx` `handleImportReplace(analysis: ImportAnalysis)`.
- Новые ключи `pages.labels.editor.import.*`: `jsonLabel`, `issuesTitle`, `warningsTitle`,
  `acknowledgeWarnings`, `warningUnknownProperty`, `warningPurposeMismatch`;
  изменён `pages.labels.editor.empty`.

- [ ] **Step 1: Написать падающие тесты**

В `apps/admin/test/labels-editor.test.tsx`:

1. В импорт из `@markiro/domain` ничего не добавлять. После константы `CYRILLIC_FIELD_ZPL`
   добавить фикстуры:

```tsx
const JSON_NAME_FIELD = {
  kind: "field",
  id: "name",
  xMm: 2,
  yMm: 2,
  field: "product.printName",
  fontSizePt: 10,
  bold: true,
  maxWidthMm: 54,
  maxLines: 3,
};

/** Four elements of the pallet 58×40 layout from the JSON-import task, as the API accepts it. */
const JSON_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    JSON_NAME_FIELD,
    { kind: "line", id: "sep1", xMm: 2, yMm: 18.2, x2Mm: 56, y2Mm: 18.2, thicknessMm: 0.3 },
    {
      kind: "text",
      id: "cap-date",
      xMm: 2,
      yMm: 18.8,
      text: "Дата производства:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-date",
      xMm: 2,
      yMm: 21.6,
      field: "date",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 18,
    },
  ],
};

/** Opens the dialog, switches it to JSON and pastes `source`; returns the dialog. */
async function openJsonImport(source: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
  const dialog = screen.getByRole("dialog", { name: "Импорт кода" });
  await chooseOption(userEvent.setup(), "Формат кода", "JSON (Markiro)");
  fireEvent.change(within(dialog).getByLabelText("JSON шаблона"), { target: { value: source } });
  return dialog;
}
```

2. В тесте `"shows the empty-state hint until code is imported"` заменить оба вхождения
   текста на `"Содержимое этикетки не задано — импортируйте код ZPL, TSPL или JSON."`.

3. После `describe("Import is the only content path", …)` добавить:

```tsx
describe("JSON import", () => {
  it("offers JSON as a third format, hides the import DPI and switches the fields panel", async () => {
    renderCreateFlow();
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
    const dialog = screen.getByRole("dialog", { name: "Импорт кода" });
    expect(within(dialog).getByRole("combobox", { name: "DPI импорта" })).toBeDefined();
    expect(within(dialog).getByLabelText("Код ZPL")).toBeDefined();

    await chooseOption(userEvent.setup(), "Формат кода", "JSON (Markiro)");

    expect(within(dialog).queryByRole("combobox", { name: "DPI импорта" })).toBeNull();
    expect(within(dialog).getByLabelText("JSON шаблона")).toBeDefined();
    expect(within(dialog).getByText("product.printName")).toBeDefined();
    expect(within(dialog).queryByText("{{product.printName}}")).toBeNull();
  });

  it("checks pasted JSON, replaces the spec, fills the default name and Save POSTs the same spec", async () => {
    const fetchMock = stubCreateFetch("new-json");
    renderCreateFlow();
    const dialog = await openJsonImport(
      JSON.stringify({ name: "Паллета 58×40", purpose: "box", spec: JSON_SPEC }),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
    expect(within(dialog).getByText("Распознано элементов: 4 · размер 58.0×40.0 мм")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Заменить этикетку" }));

    expect(screen.queryByRole("dialog", { name: "Импорт кода" })).toBeNull();
    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Паллета 58×40");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedSpec<typeof JSON_SPEC>(fetchMock)).toEqual(JSON_SPEC);
  });

  it("keeps a typed name and stays on the pasted JSON's dpi and language", async () => {
    renderCreateFlow();
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Моё имя" } });
    const dialog = await openJsonImport(
      JSON.stringify({ name: "Паллета 58×40", spec: { ...JSON_SPEC, dpi: 300, language: "tspl" } }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Заменить этикетку" }));

    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Моё имя");
    expect(
      screen.getByRole("combobox", { name: "Разрешение предпросмотра" }).textContent,
    ).toContain("300");
  });

  it("lists every schema issue with its path and blocks replacement", async () => {
    renderCreateFlow();
    const dialog = await openJsonImport(
      JSON.stringify({
        ...JSON_SPEC,
        elements: [{ kind: "text", id: "a", xMm: 1, yMm: 1, text: "x" }],
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));

    const alert = within(dialog).getByRole("alert");
    expect(within(alert).getByText(/^Ошибок в JSON: \d+$/)).toBeDefined();
    expect(within(alert).getByText("elements.0.fontSizePt")).toBeDefined();
    expect(
      within(dialog).getByRole("button", { name: "Заменить этикетку" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows a JSON syntax error as one message", async () => {
    renderCreateFlow();
    const dialog = await openJsonImport("{");
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/^invalid JSON: /);
  });

  it("requires acknowledgement for unknown properties and a purpose mismatch, then drops them", async () => {
    const fetchMock = stubCreateFetch("new-json-2");
    renderCreateFlow();
    const dialog = await openJsonImport(
      JSON.stringify({
        purpose: "pallet",
        spec: { ...JSON_SPEC, elements: [{ ...JSON_NAME_FIELD, maxlines: 2 }] },
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));

    expect(within(dialog).getByText("Предупреждения: 2")).toBeDefined();
    expect(within(dialog).getByText("elements.0.maxlines")).toBeDefined();
    expect(within(dialog).getByText('purpose: "pallet"')).toBeDefined();
    const replace = within(dialog).getByRole("button", { name: "Заменить этикетку" });
    expect(replace.hasAttribute("disabled")).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: /Продолжить с этими предупреждениями/ }),
    );
    expect(replace.hasAttribute("disabled")).toBe(false);
    fireEvent.click(replace);

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const spec = postedSpec<{ elements: Array<Record<string, unknown>> }>(fetchMock);
    expect(spec.elements[0]).not.toHaveProperty("maxlines");
    expect(spec.elements[0]).toMatchObject({ maxLines: 3 });
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin exec vitest run test/labels-editor.test.tsx`
Expected: FAIL — `"shows the empty-state hint…"` (старый текст) и все тесты `"JSON import"`
(`Unable to find role="option" and name "JSON (Markiro)"`).

- [ ] **Step 3: Добавить ключи и обновить текст пустого состояния**

В `apps/admin/src/i18n/ru.json`:

- заменить `"empty": "Содержимое этикетки не задано — импортируйте код ZPL или TSPL.",` на
  `"empty": "Содержимое этикетки не задано — импортируйте код ZPL, TSPL или JSON.",`;
- внутри `pages.labels.editor.import` после строки `"codeLabel": "Код {{format}}",` добавить:

```json
          "jsonLabel": "JSON шаблона",
```

- после строки `"elementTooLarge": "…",` добавить:

```json
          "issuesTitle": "Ошибок в JSON: {{count}}",
          "warningsTitle": "Предупреждения: {{count}}",
          "acknowledgeWarnings": "Продолжить с этими предупреждениями ({{count}})",
          "warningUnknownProperty": "свойство не входит в модель и будет отброшено",
          "warningPurposeMismatch": "не совпадает с назначением шаблона, макет будет импортирован как есть",
```

В `apps/admin/src/i18n/en.json` те же места:

- `"empty": "No label content yet — import ZPL, TSPL or JSON code.",`
- после `"codeLabel": "{{format}} code",`:

```json
          "jsonLabel": "Template JSON",
```

- после `"elementTooLarge": "…",`:

```json
          "issuesTitle": "JSON errors: {{count}}",
          "warningsTitle": "Warnings: {{count}}",
          "acknowledgeWarnings": "Continue despite these warnings ({{count}})",
          "warningUnknownProperty": "is not part of the label model and will be dropped",
          "warningPurposeMismatch": "does not match this template's purpose; the layout is imported as is",
```

- [ ] **Step 4: Переписать `ImportCodeDialog.tsx`**

Полное содержимое файла:

```tsx
import { useEffect, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  type LabelCodeLanguage,
  type LabelImportFormat,
  type LabelImportWarning,
  type LabelTemplatePurpose,
  type PrinterDpi,
} from "@markiro/domain";
import { Button, Checkbox, Modal, Select, Textarea } from "@markiro/ui";

import { analyzeImport, type ImportAnalysis, type ImportAnalysisError } from "./import-analysis.js";
import { ImportFieldsPanel } from "./ImportFieldsPanel.js";

export interface ImportCodeDialogProps {
  open: boolean;
  initialLanguage: LabelCodeLanguage;
  initialDpi: PrinterDpi;
  currentDirty: boolean;
  purpose: LabelTemplatePurpose;
  onClose: () => void;
  onReplace: (analysis: ImportAnalysis) => void;
}

const FORMAT_OPTIONS: Array<{ value: LabelImportFormat; label: string }> = [
  { value: "zpl", label: "ZPL" },
  { value: "tspl", label: "TSPL (TSC)" },
  { value: "json", label: "JSON (Markiro)" },
];

/**
 * The only way to put content on a label: paste ZPL/TSPL code or the label
 * model's own JSON, check it, acknowledge what will be dropped, replace the
 * spec. Parsing and fitting live in `analyzeImport`; this component owns the
 * dialog state and maps outcomes to copy. Any edit to the source, format or
 * DPI invalidates the analysis so a stale result can never be confirmed.
 */
export function ImportCodeDialog({
  open,
  initialLanguage,
  initialDpi,
  currentDirty,
  purpose,
  onClose,
  onReplace,
}: ImportCodeDialogProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<LabelImportFormat>(initialLanguage);
  const [dpi, setDpi] = useState<PrinterDpi>(initialDpi);
  const [source, setSource] = useState("");
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [error, setError] = useState<ImportAnalysisError | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormat(initialLanguage);
    setDpi(initialDpi);
    setSource("");
    setAnalysis(null);
    setError(null);
    setAcknowledged(false);
  }, [initialDpi, initialLanguage, open]);

  const isJson = format === "json";
  const codeLabel = isJson
    ? t("pages.labels.editor.import.jsonLabel")
    : t("pages.labels.editor.import.codeLabel", { format: format === "zpl" ? "ZPL" : "TSPL" });
  const warnings = analysis?.result.warnings ?? [];
  const canReplace = analysis !== null && (warnings.length === 0 || acknowledged) && error === null;

  function invalidate(): void {
    setAnalysis(null);
    setError(null);
    setAcknowledged(false);
  }

  function handleCheck(): void {
    invalidate();
    const outcome = analyzeImport({ source, format, dpi, purpose });
    if (outcome.ok) setAnalysis(outcome.analysis);
    else setError(outcome.error);
  }

  function handleReplace(): void {
    if (!analysis || !canReplace) return;
    onReplace(analysis);
  }

  return (
    <Modal
      open={open}
      title={t("pages.labels.editor.import.title")}
      width="min(1120px, calc(100vw - 32px))"
      className="label-editor__import-dialog"
      closeLabel={t("common.close")}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("pages.labels.editor.import.cancel")}
          </Button>
          <Button type="button" variant="secondary" onClick={handleCheck} disabled={!source.trim()}>
            {t("pages.labels.editor.import.check")}
          </Button>
          <Button type="button" onClick={handleReplace} disabled={!canReplace}>
            {t("pages.labels.editor.import.replace")}
          </Button>
        </>
      }
    >
      <div className="label-editor__import-layout">
        <div className="label-editor__import-source">
          <div className="label-editor__import-options">
            <Select
              aria-label={t("pages.labels.editor.import.formatLabel")}
              options={FORMAT_OPTIONS}
              value={format}
              onValueChange={(value) => {
                setFormat(value);
                invalidate();
              }}
            />
            {/* JSON carries its own `dpi`; the import DPI only rescales code. */}
            {!isJson && (
              <Select
                aria-label={t("pages.labels.editor.import.dpiLabel")}
                options={[
                  { value: "203", label: "203 DPI" },
                  { value: "300", label: "300 DPI" },
                ]}
                value={String(dpi)}
                onValueChange={(value) => {
                  setDpi(value === "300" ? 300 : 203);
                  invalidate();
                }}
              />
            )}
          </div>
          <label className="label-editor__import-code-label" htmlFor="label-editor-import-code">
            {codeLabel}
          </label>
          <Textarea
            id="label-editor-import-code"
            aria-label={codeLabel}
            className="label-editor__import-code"
            spellCheck={false}
            value={source}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              setSource(event.target.value);
              invalidate();
            }}
          />
          {currentDirty && (
            <p className="label-editor__import-note">{t("pages.labels.editor.import.dirtyNote")}</p>
          )}
          {error && <ImportErrorBlock error={error} />}
          {analysis && (
            <div className="label-editor__import-analysis" aria-live="polite">
              <strong>
                {t("pages.labels.editor.import.summary", {
                  count: analysis.result.spec.elements.length,
                  width: analysis.result.spec.widthMm.toFixed(1),
                  height: analysis.result.spec.heightMm.toFixed(1),
                })}
              </strong>
              {warnings.length > 0 && (
                <div className="label-editor__import-warnings">
                  <p>
                    {t(
                      isJson
                        ? "pages.labels.editor.import.warningsTitle"
                        : "pages.labels.editor.import.unsupportedTitle",
                      { count: warnings.length },
                    )}
                  </p>
                  {warnings.map((warning) => (
                    <WarningRow
                      key={`${warning.line ?? "json"}-${warning.source}`}
                      warning={warning}
                    />
                  ))}
                  <Checkbox
                    label={t(
                      isJson
                        ? "pages.labels.editor.import.acknowledgeWarnings"
                        : "pages.labels.editor.import.acknowledge",
                      { count: warnings.length },
                    )}
                    checked={acknowledged}
                    onCheckedChange={setAcknowledged}
                  />
                </div>
              )}
              {analysis.adjustedIds.length > 0 && (
                <p>
                  {t("pages.labels.editor.import.adjusted", { count: analysis.adjustedIds.length })}
                </p>
              )}
            </div>
          )}
        </div>
        <ImportFieldsPanel syntax={isJson ? "json" : "placeholder"} />
      </div>
    </Modal>
  );
}

/** One warning line; the copy depends on what kind of thing is being dropped. */
function WarningRow({ warning }: { warning: LabelImportWarning }) {
  const { t } = useTranslation();
  switch (warning.code) {
    case "UNSUPPORTED_COMMAND":
      return (
        <div>
          <span>{warning.line}: </span>
          <code>{warning.source}</code>
        </div>
      );
    case "UNKNOWN_PROPERTY":
      return (
        <div>
          <code>{warning.source}</code> {t("pages.labels.editor.import.warningUnknownProperty")}
        </div>
      );
    case "PURPOSE_MISMATCH":
      return (
        <div>
          <code>{warning.source}</code> {t("pages.labels.editor.import.warningPurposeMismatch")}
        </div>
      );
  }
}

/** A blocking error: one message, or the schema's full issue list with paths. */
function ImportErrorBlock({ error }: { error: ImportAnalysisError }) {
  const { t } = useTranslation();
  if (error.kind === "issues") {
    return (
      <div className="label-editor__import-error" role="alert">
        <p>{t("pages.labels.editor.import.issuesTitle", { count: error.issues.length })}</p>
        <ul className="label-editor__import-issues">
          {error.issues.map((issue, index) => (
            <li key={`${index}-${issue.path}`}>
              <code>{issue.path || "spec"}</code> {issue.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="label-editor__import-error" role="alert">
      {error.kind === "elementTooLarge"
        ? t("pages.labels.editor.import.elementTooLarge")
        : error.message}
    </div>
  );
}
```

- [ ] **Step 5: Обновить `index.tsx`**

1. В импорте из `@markiro/domain` удалить строку `type LabelImportResult,`.
2. После `import { ImportCodeDialog } from "./ImportCodeDialog.js";` добавить
   `import type { ImportAnalysis } from "./import-analysis.js";`.
3. Заменить функцию `handleImportReplace` на:

```tsx
function handleImportReplace(analysis: ImportAnalysis): void {
  const nextSpec = analysis.result.spec;
  editor.replaceSpec(nextSpec);
  setCustomSize(matchPresetKey(nextSpec.widthMm, nextSpec.heightMm) === null);
  clearSizeDrafts();
  // A pasted `{ name, purpose, spec }` body names the template only while
  // the name is still the untouched default of a new template (or blank);
  // a typed or saved name is never overwritten by an import.
  if (
    analysis.name !== undefined &&
    (name.trim() === "" || name === t("pages.labels.editor.defaultName"))
  ) {
    setName(analysis.name);
  }
  markDirty();
  setShowImportDialog(false);
}
```

- [ ] **Step 6: Стили списка ошибок**

В `apps/admin/src/pages/labels/editor/editor.css` заменить правило
`.label-editor__import-warnings code { … }` на:

```css
.label-editor__import-warnings code,
.label-editor__import-issues code {
  overflow-wrap: anywhere;
  color: var(--fg-2);
  font: 12px/1.4 var(--font-mono);
}

.label-editor__import-error p {
  margin: 0;
}

.label-editor__import-issues {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding-left: 18px;
}
```

- [ ] **Step 7: Прогнать тесты**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin exec vitest run test/labels-editor.test.tsx test/labels-import-fields-panel.test.tsx test/i18n.test.tsx test/label-samples.test.ts`
Expected: PASS, включая все шесть тестов `"JSON import"` и прежние тесты импорта ZPL.

- [ ] **Step 8: Typecheck и lint админки**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin lint`
Expected: без ошибок.

- [ ] **Step 9: Коммит**

```bash
git add apps/admin/src/pages/labels/editor/ImportCodeDialog.tsx apps/admin/src/pages/labels/editor/index.tsx apps/admin/src/pages/labels/editor/editor.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/labels-editor.test.tsx
git commit -m "feat(admin): import a label template from JSON in the import dialog

Third format next to ZPL and TSPL: the same document POST /label-templates
accepts, validated by the same schema, with every issue listed by path and
dropped properties surfaced as warnings. A pasted body's name fills an
untouched template name.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: «Скачать JSON»

**Files:**

- Modify: `apps/admin/src/pages/labels/editor/download.ts` (импорт типов, `buildJsonBlob`)
- Modify: `apps/admin/src/pages/labels/editor/index.tsx` (импорт, `handleDownload`, кнопка)
- Test: `apps/admin/test/labels-editor.test.tsx`

**Interfaces:**

- Produces:
  ```ts
  export interface LabelTemplateJsonPayload {
    name: string;
    purpose: LabelTemplatePurpose;
    spec: LabelTemplateSpec;
  }
  export function buildJsonBlob(payload: LabelTemplateJsonPayload): Blob; // application/json, UTF-8, 2 пробела, "\n" в конце
  ```
- Consumes: `analyzeImport` (Task 4) в тесте кругового прогона.

- [ ] **Step 1: Написать падающие тесты**

В `apps/admin/test/labels-editor.test.tsx`:

1. Заменить импорт из `download.js` на:

```tsx
import {
  buildJsonBlob,
  buildZplBlob,
  latin1ToUint8Array,
} from "../src/pages/labels/editor/download.js";
import { analyzeImport } from "../src/pages/labels/editor/import-analysis.js";
```

2. В тесте `"the deleted canvas-editor chrome is gone"` — ничего. В тесте на строках ~304-305
   (`expect(screen.getByRole("button", { name: "Скачать ZPL" }))…`) добавить строку:

```tsx
expect(screen.getByRole("button", { name: "Скачать JSON" })).toBeDefined();
```

3. Рядом с тестом `"buildZplBlob keeps a Latin-1 byte…"` добавить:

```tsx
it("buildJsonBlob pretty-prints UTF-8 JSON in name/purpose/spec order with a trailing newline", async () => {
  const spec = parseLabelTemplate(JSON_SPEC);
  const blob = buildJsonBlob({ spec, purpose: "box", name: "Короб 58×40" });
  expect(blob.type).toBe("application/json");
  const text = new TextDecoder().decode(await blob.arrayBuffer());
  expect(text).toBe(`${JSON.stringify({ name: "Короб 58×40", purpose: "box", spec }, null, 2)}\n`);
});

it("Скачать JSON downloads { name, purpose, spec } of the current editor state, and the file imports back unchanged", async () => {
  const blobs: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    if (!(value instanceof Blob)) throw new Error("Expected a downloadable label");
    blobs.push(value);
    return "blob:mock-url";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  renderCreateFlow();
  importZpl(IMPORT_ZPL);
  fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Короб 58×40" } });

  fireEvent.click(screen.getByRole("button", { name: "Скачать JSON" }));

  await waitFor(() => expect(blobs).toHaveLength(1));
  const blob = blobs[0];
  if (!blob) throw new Error("Missing downloaded JSON");
  expect(blob.type).toBe("application/json");
  const text = new TextDecoder().decode(await blob.arrayBuffer());
  const payload = JSON.parse(text) as { name: string; purpose: string; spec: unknown };
  expect(Object.keys(payload)).toEqual(["name", "purpose", "spec"]);
  expect(payload.name).toBe("Короб 58×40");
  expect(payload.purpose).toBe("box");
  expect(() => parseLabelTemplate(payload.spec)).not.toThrow();
  expect((payload.spec as { elements: unknown[] }).elements).toHaveLength(2);

  // Round trip: the downloaded file is exactly what the JSON importer takes back.
  const outcome = analyzeImport({ source: text, format: "json", dpi: 203, purpose: "box" });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.analysis.result.spec).toEqual(payload.spec);
  expect(outcome.analysis.result.warnings).toEqual([]);
  expect(outcome.analysis.name).toBe("Короб 58×40");
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin exec vitest run test/labels-editor.test.tsx`
Expected: FAIL — `buildJsonBlob` не экспортируется; кнопка «Скачать JSON» не найдена.

- [ ] **Step 3: `buildJsonBlob` в `download.ts`**

В начало файла (после doc-комментария модуля, перед `latin1ToUint8Array`) добавить:

```ts
import type { LabelTemplatePurpose, LabelTemplateSpec } from "@markiro/domain";

export interface LabelTemplateJsonPayload {
  name: string;
  purpose: LabelTemplatePurpose;
  spec: LabelTemplateSpec;
}

/**
 * The downloadable JSON twin of a template: `{ name, purpose, spec }`,
 * pretty-printed -- the exact body `POST /label-templates` accepts and the
 * exact text the import dialog's JSON format takes back. Deliberately NOT
 * routed through `latin1ToUint8Array` (see the module comment): unlike the
 * ZPL/TSPL documents, JSON is text, and a Cyrillic template name or caption
 * must reach the file as UTF-8, which is what `Blob` does with a string. Key
 * order is fixed so a diff of two exports reads top-down: name, purpose,
 * layout.
 */
export function buildJsonBlob(payload: LabelTemplateJsonPayload): Blob {
  const ordered = { name: payload.name, purpose: payload.purpose, spec: payload.spec };
  return new Blob([`${JSON.stringify(ordered, null, 2)}\n`], { type: "application/json" });
}
```

- [ ] **Step 4: Кнопка и обработчик в `index.tsx`**

1. В импорте из `./download.js` добавить `buildJsonBlob`:

```ts
import {
  buildJsonBlob,
  buildTsplBlob,
  buildZplBlob,
  downloadBlob,
  safeFileName,
} from "./download.js";
```

2. Заменить начало `handleDownload` (сигнатуру и первые строки до `const sample = …`) на:

```tsx
  async function handleDownload(format: "zpl" | "tspl" | "json"): Promise<void> {
    // JSON is the model itself: nothing to generate, nothing that can fail,
    // so it is offered even while a duplicate template is temporarily invalid.
    if (format === "json") {
      downloadBlob(buildJsonBlob({ name, purpose, spec }), `${safeFileName(name)}.json`);
      return;
    }
    if (duplicateInvalid) return;
    const sample = labelPreviewData(purpose);
```

(остальное тело функции без изменений). Обновить doc-комментарий над функцией:
`Both downloads` → `All three downloads`.

3. После кнопки `{t("pages.labels.editor.download", { format: "TSPL (TSC)" })}` добавить:

```tsx
<Button type="button" variant="secondary" onClick={() => void handleDownload("json")}>
  {t("pages.labels.editor.download", { format: "JSON" })}
</Button>
```

- [ ] **Step 5: Прогнать тесты, typecheck, lint**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin exec vitest run test/labels-editor.test.tsx`
Expected: PASS.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin lint`
Expected: без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add apps/admin/src/pages/labels/editor/download.ts apps/admin/src/pages/labels/editor/index.tsx apps/admin/test/labels-editor.test.tsx
git commit -m "feat(admin): download a label template as JSON

{ name, purpose, spec } of the current editor state; the file imports back
through the dialog and posts to the API unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Финальные гейты и статус спеки

**Files:**

- Modify: `docs/superpowers/specs/2026-09-18-label-editor-json-import-design.md:5`

- [ ] **Step 1: Полные гейты домена и админки**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain test && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain lint && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build`
Expected: всё зелёное.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin test && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin lint && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/admin build`
Expected: всё зелёное (`test` включает `label-samples.test.ts`: 30 образцов без изменений).

- [ ] **Step 2: Потребители домена, которых не трогали**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/label-templates-openapi.test.ts && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api typecheck`
Expected: PASS — OpenAPI-схема шаблона не изменилась. В свежем worktree перед этим
`pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/api^...'`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/box-label.test.ts && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station typecheck`
Expected: PASS — станция потребляет `LabelTemplateSpec` и эмиттеры, их контракт прежний.
(Если станции нужен собранный `@markiro/ui`: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/ui build`.)

- [ ] **Step 3: Формат и чистота диффа**

Run: `pnpm --config.verifyDepsBeforeRun=false format:check && git diff --check`
Expected: без замечаний. Если `format:check` ругается на тронутые файлы —
`pnpm --config.verifyDepsBeforeRun=false exec prettier --write <файлы>` и перепрогнать тесты
затронутого пакета.

- [ ] **Step 4: Статус спеки**

В `docs/superpowers/specs/2026-09-18-label-editor-json-import-design.md` заменить
`**Status:** Draft (branch claude/label-editor-json-import-7c4234)` на
`**Status:** Implemented (branch claude/label-editor-json-import-7c4234, 2026-09-18)`.

- [ ] **Step 5: Коммит**

```bash
git add docs/superpowers/specs/2026-09-18-label-editor-json-import-design.md
git commit -m "docs: mark the label editor JSON import spec as implemented

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6: Итоговый отчёт**

Перечислить: изменённое поведение (JSON-импорт, «Скачать JSON», `^FB` → `maxLines`);
затронутые файлы; автоматические проверки и их результат по пакетам; что **не**
проверялось: живой браузер (тесты — jsdom), физическая печать, станция с реальным принтером.
