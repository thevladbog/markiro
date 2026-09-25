# Этап 0: печатные формы в `@markiro/domain` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** перенести чистые генераторы печатных форм («Состав короба», «Состав паллеты», «Ярлык паллеты», «Бланк смены» и общее оформление бланков) из `apps/api` в `packages/domain`, чтобы их могли использовать и облачный API, и будущее автономное приложение. Вывод при этом не меняется ни на байт.

**Architecture:** сначала фиксируем текущий вывод HTML-слепками (characterisation lock) в API. Затем переносим шесть модулей в `packages/domain/src/print-forms/` через `git mv`, переписываем импорты под стиль домена (`.js`-суффиксы, внутренние модули вместо `@markiro/domain`), экспортируем публичную поверхность из индекса домена и переводим потребителей API и браузерный контракт админки на новое место. Тесты рендера и слепки переезжают вместе с кодом; тесты DTO API остаются в API.

**Tech Stack:** TypeScript 6 (strict, NodeNext в домене, CommonJS/node10 в API), Vitest 4 (`toMatchFileSnapshot`), NestJS 11, pnpm/turbo.

**Спецификация:** `docs/superpowers/specs/2026-09-26-standalone-station-design.md`, раздел 8.2 и этап 0 в разделе 13.

## Global Constraints

- Вывод каждой формы побайтово совпадает с выводом до переноса; доказательство — слепки из задачи 1, проверяемые с `CI=true` (Vitest не пишет недостающие слепки).
- Никаких изменений поведения: только перенос файлов, импорты, экспорты, тесты и документация.
- Новых зависимостей нет.
- Внутри `packages/domain` относительные импорты пишутся с суффиксом `.js`; импорты из `@markiro/domain` внутри домена запрещены.
- `import type` для импортов, используемых только как типы.
- HTML-слепки исключены из Prettier (как `apps/api/test/fixtures/inventory-task-form.snapshot.html`).
- Коммиты — только явные пути, сообщения в стиле репозитория, с трейлером `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `apps/station` не меняется.

## Файлы

Создаются:

- `apps/api/test/print-forms-snapshot.test.ts` (задача 1; в задаче 2 переезжает в `packages/domain/test/print-forms-snapshot.test.ts`)
- `apps/api/test/fixtures/print-forms/*.html` (задача 1; в задаче 2 переезжают в `packages/domain/test/fixtures/print-forms/`)
- `apps/api/test/box-report-query.test.ts` (задача 2: тесты DTO, отделённые от тестов рендера)

Переносятся (`git mv`, задача 2):

- `apps/api/src/modules/code-search/contents-report.ts` → `packages/domain/src/print-forms/contents-report.ts`
- `apps/api/src/modules/code-search/box-report.ts` → `packages/domain/src/print-forms/box-report.ts`
- `apps/api/src/modules/code-search/pallet-report.ts` → `packages/domain/src/print-forms/pallet-report.ts`
- `apps/api/src/modules/code-search/pallet-placard.ts` → `packages/domain/src/print-forms/pallet-placard.ts`
- `apps/api/src/modules/print/task-form-chrome.ts` → `packages/domain/src/print-forms/task-form-chrome.ts`
- `apps/api/src/modules/shifts/shift-task-form.ts` → `packages/domain/src/print-forms/shift-task-form.ts`
- `apps/api/test/box-report.test.ts` → `packages/domain/test/box-report.test.ts`
- `apps/api/test/pallet-report.test.ts` → `packages/domain/test/pallet-report.test.ts`
- `apps/api/test/pallet-placard.test.ts` → `packages/domain/test/pallet-placard.test.ts`
- `apps/api/test/shift-task-form.test.ts` → `packages/domain/test/shift-task-form.test.ts`

Меняются:

- `packages/domain/src/index.ts` — экспорт публичной поверхности печатных форм
- `apps/api/src/modules/code-search/code-search.controller.ts`, `code-search.service.ts`
- `apps/api/src/modules/shifts/shifts.controller.ts`, `shifts.service.ts`
- `apps/api/src/modules/inventories/inventory-task-form.ts`
- `apps/admin/test/browser/box-report-render.mjs`
- `.prettierignore`
- `docs/architecture.md`, `AGENTS.md` (одна фраза о составе домена)

---

### Task 1: HTML-слепки текущего вывода в API

**Files:**

- Create: `apps/api/test/print-forms-snapshot.test.ts`
- Create (генерируются тестом): `apps/api/test/fixtures/print-forms/box-report.html`, `box-report-empty.html`, `pallet-report.html`, `pallet-placard-a4.html`, `pallet-placard-a5.html`, `shift-placards-a5.html`, `shift-task-form-aggregation.html`, `shift-task-form-validation.html`
- Modify: `.prettierignore`

**Interfaces:**

- Consumes: `renderBoxReportHtml(data: BoxReportData, timeZone = "UTC"): string`, `renderPalletReportHtml(data: PalletReportData, timeZone = "UTC"): string`, `renderPalletPlacardHtml(data: PalletPlacardData, format: PlacardFormat): string`, `renderShiftPlacardsHtml(pallets: readonly PalletPlacardData[], format: PlacardFormat, shiftNumber: string | null): string`, `renderShiftTaskFormHtml(data: ShiftTaskFormData): string` — в текущих путях API.
- Produces: файлы слепков `fixtures/print-forms/*.html` и тест, который в задаче 2 переезжает в домен без изменения фикстур.

- [ ] **Step 1: Исключить каталог слепков из Prettier**

Добавить в конец `.prettierignore`:

```gitignore

# Characterisation fixtures for the printable forms: these bytes ARE the
# contract while the forms move into @markiro/domain. print-forms-snapshot.test.ts
# compares every render with its file byte for byte; reformatting would compare
# the renderers against Prettier's opinion instead of the shipped output.
apps/api/test/fixtures/print-forms/
```

- [ ] **Step 2: Написать тест слепков**

Создать `apps/api/test/print-forms-snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { renderBoxReportHtml, type BoxReportData } from "../src/modules/code-search/box-report";
import {
  renderPalletPlacardHtml,
  renderShiftPlacardsHtml,
  type PalletPlacardData,
} from "../src/modules/code-search/pallet-placard";
import {
  renderPalletReportHtml,
  type PalletReportData,
} from "../src/modules/code-search/pallet-report";
import {
  renderShiftTaskFormHtml,
  type ShiftTaskFormData,
} from "../src/modules/shifts/shift-task-form";

/**
 * Characterisation lock for moving the printable forms into @markiro/domain
 * (docs/superpowers/plans/2026-09-26-standalone-00-print-forms-to-domain.md).
 * The files under fixtures/print-forms are the contract: the move must not
 * change a single byte, so they are compared verbatim and kept out of Prettier.
 */

/** GS (ASCII 0x1D), the real KM separator byte. */
const GS = String.fromCharCode(0x1d);
/** Check-digit-valid GTIN; `renderDataMatrixSvg` enforces the AI-01 mod-10. */
const GTIN = "04600682000013";

const BOX: BoxReportData = {
  sscc: "00146007034967000010",
  status: "closed",
  productName: "Жигулёвское светлое 0,5 л",
  org: { name: "ООО «Пивзавод „Заря“»", inn: "5029087641", logo: null },
  openedAt: new Date("2026-09-09T21:58:00.000Z"),
  closedAt: new Date("2026-09-09T22:08:00.000Z"),
  disassembledAt: null,
  codes: [1, 2, 3].map((n) => ({
    gtin14: GTIN,
    serial: `SER${n}`,
    rawKm: `01${GTIN}21SER${n}${GS}93Abcd`,
  })),
};

const EMPTY_BOX: BoxReportData = {
  ...BOX,
  sscc: null,
  status: "disassembled",
  disassembledAt: new Date("2026-09-09T23:08:00.000Z"),
  codes: [],
};

const PALLET: PalletReportData = {
  sscc: "00146007034967100001",
  status: "closed",
  productName: "Жигулёвское светлое 0,5 л",
  org: { name: "ООО «Пивзавод „Заря“»", inn: "5029087641", logo: null },
  openedAt: new Date("2026-09-11T06:00:00.000Z"),
  closedAt: new Date("2026-09-11T09:30:00.000Z"),
  disassembledAt: null,
  boxes: [
    { sscc: "00146007034967000001", codeCount: 12, disassembledAt: null },
    {
      sscc: "00146007034967000002",
      codeCount: 12,
      disassembledAt: new Date("2026-09-11T08:00:00.000Z"),
    },
    { sscc: null, codeCount: 7, disassembledAt: null },
  ],
};

const PLACARD: PalletPlacardData = {
  sscc: "00104600682000000019",
  status: "closed",
  productName: "Вода питьевая негазированная «Атолл» 0,5 л, ПЭТ",
  gtin14: GTIN,
  shelfLifeDays: 180,
  org: { name: "ООО «Атолл»", inn: "7701234567", logo: null },
  boxes: [
    { productionDate: "2026-09-10", codeCount: 20, disassembledAt: null },
    { productionDate: "2026-09-14", codeCount: 20, disassembledAt: null },
    { productionDate: "2026-09-10", codeCount: 20, disassembledAt: null },
    { productionDate: null, codeCount: 18, disassembledAt: null },
  ],
};

const SECOND_PLACARD: PalletPlacardData = {
  ...PLACARD,
  sscc: null,
  status: "open",
  boxes: [{ productionDate: "2026-09-14", codeCount: 20, disassembledAt: null }],
};

const TASK: ShiftTaskFormData = {
  shiftId: "22222222-2222-4222-8222-222222222222",
  shiftNumber: "SEP26-014",
  status: "planned",
  mode: "aggregation",
  organizationName: "ООО «Атолл»",
  productId: "33333333-3333-4333-8333-333333333333",
  productName: "Вода питьевая «Атолл» негазированная, ПЭТ 0,5 л",
  productPrintName: "Атолл 0,5 л н/г",
  gtin14: "04607091380019",
  imageChecksum: "a".repeat(64),
  lineName: "Линия розлива №2",
  plannedDate: "2026-09-21",
  productionDate: "2026-09-21",
  plannedQty: 12_000,
  boxCapacity: 24,
  palletsEnabled: true,
  palletBoxCapacity: 40,
  counterpartyName: "ООО «Торговый дом Ромашка»",
  ssccIssuerName: null,
  validationPrintMode: "none",
  validationPrintVerification: "none",
  allowPreviouslyAcceptedCodes: false,
  generatedAt: new Date("2026-09-19T11:20:00.000Z"),
};

const VALIDATION_TASK: ShiftTaskFormData = {
  ...TASK,
  status: "active",
  mode: "validation",
  imageChecksum: null,
  boxCapacity: null,
  palletsEnabled: false,
  palletBoxCapacity: null,
  validationPrintMode: "duplicate_dm",
  validationPrintVerification: "required",
  allowPreviouslyAcceptedCodes: true,
};

describe("printable forms characterisation lock", () => {
  it("box contents report", async () => {
    await expect(renderBoxReportHtml(BOX, "Europe/Moscow")).toMatchFileSnapshot(
      "fixtures/print-forms/box-report.html",
    );
  });

  it("empty disassembled box without an SSCC", async () => {
    await expect(renderBoxReportHtml(EMPTY_BOX)).toMatchFileSnapshot(
      "fixtures/print-forms/box-report-empty.html",
    );
  });

  it("pallet contents report", async () => {
    await expect(renderPalletReportHtml(PALLET, "Asia/Vladivostok")).toMatchFileSnapshot(
      "fixtures/print-forms/pallet-report.html",
    );
  });

  it("pallet placard, A4", async () => {
    await expect(renderPalletPlacardHtml(PLACARD, "a4")).toMatchFileSnapshot(
      "fixtures/print-forms/pallet-placard-a4.html",
    );
  });

  it("pallet placard, A5", async () => {
    await expect(renderPalletPlacardHtml(PLACARD, "a5")).toMatchFileSnapshot(
      "fixtures/print-forms/pallet-placard-a5.html",
    );
  });

  it("all placards of a shift, A5", async () => {
    await expect(
      renderShiftPlacardsHtml([PLACARD, SECOND_PLACARD], "a5", "SEP26-014"),
    ).toMatchFileSnapshot("fixtures/print-forms/shift-placards-a5.html");
  });

  it("aggregation shift task form", async () => {
    await expect(renderShiftTaskFormHtml(TASK)).toMatchFileSnapshot(
      "fixtures/print-forms/shift-task-form-aggregation.html",
    );
  });

  it("validation shift task form with a duplicate Data Matrix", async () => {
    await expect(renderShiftTaskFormHtml(VALIDATION_TASK)).toMatchFileSnapshot(
      "fixtures/print-forms/shift-task-form-validation.html",
    );
  });
});
```

- [ ] **Step 3: Собрать домен и один раз записать слепки**

Run:

```bash
pnpm --filter @markiro/domain build
env -u CI pnpm --filter @markiro/api exec vitest run test/print-forms-snapshot.test.ts
ls apps/api/test/fixtures/print-forms
```

Expected: 8 тестов PASS (Vitest записывает недостающие файлы слепков), в каталоге восемь `.html`-файлов. Если какой-то рендер бросает исключение — это ошибка фикстуры; поправить значение по образцу соответствующего существующего теста (`apps/api/test/*-report.test.ts`, `pallet-placard.test.ts`, `shift-task-form.test.ts`), а не генератор.

- [ ] **Step 4: Убедиться, что слепки проверяются, а не перезаписываются**

Run:

```bash
CI=true pnpm --filter @markiro/api exec vitest run test/print-forms-snapshot.test.ts
node_modules/.bin/prettier --check .prettierignore apps/api/test/print-forms-snapshot.test.ts
```

Expected: 8 PASS; Prettier — «All matched files use Prettier code style!». Проверка отрицательного случая: временно заменить в `apps/api/test/fixtures/print-forms/box-report.html` любой символ, повторить первую команду — ожидается FAIL «mismatched»; вернуть файл командой `git checkout -- apps/api/test/fixtures/print-forms/box-report.html`, если он уже закоммичен, иначе перегенерировать шагом 3.

- [ ] **Step 5: Commit**

```bash
git add .prettierignore apps/api/test/print-forms-snapshot.test.ts apps/api/test/fixtures/print-forms
git commit -m "test(api): слепки HTML печатных форм перед переносом в домен" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Перенос генераторов в `packages/domain/src/print-forms/`

**Files:**

- Move: шесть модулей и четыре теста (см. раздел «Файлы»), тест слепков и каталог слепков
- Create: `apps/api/test/box-report-query.test.ts`
- Modify: `packages/domain/src/index.ts`, `apps/api/src/modules/code-search/code-search.controller.ts`, `apps/api/src/modules/code-search/code-search.service.ts`, `apps/api/src/modules/shifts/shifts.controller.ts`, `apps/api/src/modules/shifts/shifts.service.ts`, `apps/api/src/modules/inventories/inventory-task-form.ts`, `apps/admin/test/browser/box-report-render.mjs`, `.prettierignore`

**Interfaces:**

- Consumes: слепки и тест из задачи 1; внутренние модули домена `../barcodes/svg.js` (`renderCode128Svg`, `renderDataMatrixSvg`, `renderLiteralDataMatrixSvg`), `../barcodes/task-tokens.js` (`formatShiftTaskBarcode`), `../labels/shelf-life.js` (`shelfLifeExpiryDate`).
- Produces (экспорт `@markiro/domain`): `renderBoxReportHtml`, `renderPalletReportHtml`, `renderPalletPlacardHtml`, `renderShiftPlacardsHtml`, `summarizeByProductionDate`, `renderShiftTaskFormHtml`, пространство имён `taskFormChrome` (все экспорты `task-form-chrome.ts`), типы `ReportCode`, `ReportOrg`, `BoxReportCode`, `BoxReportData`, `PalletReportBox`, `PalletReportData`, `PalletPlacardBox`, `PalletPlacardData`, `PlacardDateRow`, `PlacardFormat`, `ShiftTaskFormData`. Сигнатуры функций не меняются.

- [ ] **Step 1: Перенести модули**

Run:

```bash
mkdir -p packages/domain/src/print-forms
git mv apps/api/src/modules/code-search/contents-report.ts packages/domain/src/print-forms/contents-report.ts
git mv apps/api/src/modules/code-search/box-report.ts packages/domain/src/print-forms/box-report.ts
git mv apps/api/src/modules/code-search/pallet-report.ts packages/domain/src/print-forms/pallet-report.ts
git mv apps/api/src/modules/code-search/pallet-placard.ts packages/domain/src/print-forms/pallet-placard.ts
git mv apps/api/src/modules/print/task-form-chrome.ts packages/domain/src/print-forms/task-form-chrome.ts
git mv apps/api/src/modules/shifts/shift-task-form.ts packages/domain/src/print-forms/shift-task-form.ts
```

- [ ] **Step 2: Переписать импорты перенесённых модулей под стиль домена**

`packages/domain/src/print-forms/contents-report.ts` — заменить строку

```ts
import { renderCode128Svg, renderDataMatrixSvg } from "@markiro/domain";
```

на

```ts
import { renderCode128Svg, renderDataMatrixSvg } from "../barcodes/svg.js";
```

`packages/domain/src/print-forms/box-report.ts` и `packages/domain/src/print-forms/pallet-report.ts` — в конце блока импорта заменить

```ts
} from "./contents-report";
```

на

```ts
} from "./contents-report.js";
```

`packages/domain/src/print-forms/pallet-placard.ts` — заменить две строки импорта

```ts
import { shelfLifeExpiryDate } from "@markiro/domain";
import { brandLogo, escapeHtml, ssccBarcode, ssccHri, type ReportOrg } from "./contents-report";
```

на

```ts
import { shelfLifeExpiryDate } from "../labels/shelf-life.js";
import { brandLogo, escapeHtml, ssccBarcode, ssccHri, type ReportOrg } from "./contents-report.js";
```

`packages/domain/src/print-forms/shift-task-form.ts` — заменить

```ts
import { formatShiftTaskBarcode, renderLiteralDataMatrixSvg } from "@markiro/domain";
```

на

```ts
import { renderLiteralDataMatrixSvg } from "../barcodes/svg.js";
import { formatShiftTaskBarcode } from "../barcodes/task-tokens.js";
```

и в конце второго блока импорта заменить

```ts
} from "../print/task-form-chrome";
```

на

```ts
} from "./task-form-chrome.js";
```

`task-form-chrome.ts` импортов не имеет и не меняется.

- [ ] **Step 3: Экспортировать публичную поверхность из индекса домена**

Добавить в конец `packages/domain/src/index.ts`:

```ts
export type { ReportCode, ReportOrg } from "./print-forms/contents-report.js";
export { renderBoxReportHtml } from "./print-forms/box-report.js";
export type { BoxReportCode, BoxReportData } from "./print-forms/box-report.js";
export { renderPalletReportHtml } from "./print-forms/pallet-report.js";
export type { PalletReportBox, PalletReportData } from "./print-forms/pallet-report.js";
export {
  renderPalletPlacardHtml,
  renderShiftPlacardsHtml,
  summarizeByProductionDate,
} from "./print-forms/pallet-placard.js";
export type {
  PalletPlacardBox,
  PalletPlacardData,
  PlacardDateRow,
  PlacardFormat,
} from "./print-forms/pallet-placard.js";
export { renderShiftTaskFormHtml } from "./print-forms/shift-task-form.js";
export type { ShiftTaskFormData } from "./print-forms/shift-task-form.js";
// Chrome helpers stay grouped: `escapeHtml` and friends are generic names, and
// the box-report module has its own `escapeHtml` that must not be confused
// with this one.
export * as taskFormChrome from "./print-forms/task-form-chrome.js";
```

- [ ] **Step 4: Проверить, что домен собирается**

Run:

```bash
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain build
ls packages/domain/dist/print-forms
```

Expected: typecheck без ошибок; в `dist/print-forms` есть `.js` и `.d.ts` для шести модулей.

- [ ] **Step 5: Перевести потребителей API**

`apps/api/src/modules/code-search/code-search.controller.ts` — заменить три строки

```ts
import { renderBoxReportHtml } from "./box-report";
import { renderPalletReportHtml } from "./pallet-report";
import { renderPalletPlacardHtml, renderShiftPlacardsHtml } from "./pallet-placard";
```

на

```ts
import {
  renderBoxReportHtml,
  renderPalletPlacardHtml,
  renderPalletReportHtml,
  renderShiftPlacardsHtml,
} from "@markiro/domain";
```

Во всех четырёх файлах ниже уже есть импорты из `"@markiro/domain"` (в `shifts.service.ts` их четыре), так что новая строка добавляется отдельным оператором импорта, без слияния с существующими.

`apps/api/src/modules/code-search/code-search.service.ts` — заменить строки

```ts
import type { BoxReportData } from "./box-report";
import type { PalletReportData } from "./pallet-report";
import type { ReportOrg } from "./contents-report";
```

и

```ts
import type { PalletPlacardData } from "./pallet-placard";
```

одной строкой

```ts
import type {
  BoxReportData,
  PalletPlacardData,
  PalletReportData,
  ReportOrg,
} from "@markiro/domain";
```

`apps/api/src/modules/shifts/shifts.controller.ts` — заменить

```ts
import { renderShiftTaskFormHtml } from "./shift-task-form";
```

на

```ts
import { renderShiftTaskFormHtml } from "@markiro/domain";
```

`apps/api/src/modules/shifts/shifts.service.ts` — заменить

```ts
import type { ShiftTaskFormData } from "./shift-task-form";
```

на

```ts
import type { ShiftTaskFormData } from "@markiro/domain";
```

Порядок импортов после правки выравнивает Prettier в шаге 11; ESLint в шаге 9 подтвердит, что правила импорта соблюдены.

`apps/api/src/modules/inventories/inventory-task-form.ts` — заменить начало файла

```ts
import { renderLiteralDataMatrixSvg } from "@markiro/domain";

import {
  boundPrintText,
  countNoun,
  escapeHtml,
  formatCivilDate,
  formatGeneratedAt,
  formatInteger,
  TASK_FORM_BASE_CSS,
  taskFormLogoSvg,
  taskFormParameter,
  taskFormStep,
} from "../print/task-form-chrome";
import { formatInventoryTaskBarcode } from "./station-inventory.dto";
```

на

```ts
import { renderLiteralDataMatrixSvg, taskFormChrome } from "@markiro/domain";

import { formatInventoryTaskBarcode } from "./station-inventory.dto";

const {
  boundPrintText,
  countNoun,
  escapeHtml,
  formatCivilDate,
  formatGeneratedAt,
  formatInteger,
  TASK_FORM_BASE_CSS,
  taskFormLogoSvg,
  taskFormParameter,
  taskFormStep,
} = taskFormChrome;
```

Остальной код файла не меняется. Убедиться, что каталог `apps/api/src/modules/print/` пуст и удалён (`git mv` его опустошил; пустые каталоги git не хранит).

- [ ] **Step 6: Перенести тесты рендера и отделить тесты DTO**

Run:

```bash
git mv apps/api/test/box-report.test.ts packages/domain/test/box-report.test.ts
git mv apps/api/test/pallet-report.test.ts packages/domain/test/pallet-report.test.ts
git mv apps/api/test/pallet-placard.test.ts packages/domain/test/pallet-placard.test.ts
git mv apps/api/test/shift-task-form.test.ts packages/domain/test/shift-task-form.test.ts
git mv apps/api/test/print-forms-snapshot.test.ts packages/domain/test/print-forms-snapshot.test.ts
mkdir -p packages/domain/test/fixtures
git mv apps/api/test/fixtures/print-forms packages/domain/test/fixtures/print-forms
```

Переписать импорты в перенесённых тестах:

- `packages/domain/test/pallet-report.test.ts`: `from "../src/modules/code-search/contents-report";` → `from "../src/print-forms/contents-report.js";` и `} from "../src/modules/code-search/pallet-report";` → `} from "../src/print-forms/pallet-report.js";`
- `packages/domain/test/pallet-placard.test.ts`: `} from "../src/modules/code-search/pallet-placard";` → `} from "../src/print-forms/pallet-placard.js";`
- `packages/domain/test/shift-task-form.test.ts`: `} from "../src/modules/shifts/shift-task-form";` → `} from "../src/print-forms/shift-task-form.js";`
- `packages/domain/test/print-forms-snapshot.test.ts`: четыре пути `../src/modules/code-search/box-report`, `../src/modules/code-search/pallet-placard`, `../src/modules/code-search/pallet-report`, `../src/modules/shifts/shift-task-form` → `../src/print-forms/box-report.js`, `../src/print-forms/pallet-placard.js`, `../src/print-forms/pallet-report.js`, `../src/print-forms/shift-task-form.js`. Пути к слепкам (`fixtures/print-forms/...`) не меняются: они относительны к файлу теста.

`packages/domain/test/box-report.test.ts` — удалить строку

```ts
import { boxReportQuerySchema } from "../src/modules/code-search/dto";
```

заменить

```ts
import { renderBoxReportHtml, type BoxReportData } from "../src/modules/code-search/box-report";
```

на

```ts
import { renderBoxReportHtml, type BoxReportData } from "../src/print-forms/box-report.js";
```

и заменить два первых теста блока `describe("renderBoxReportHtml", …)` (фрагменты даны с отступами, как в файле):

<!-- prettier-ignore -->
```ts
  it("retains UTC for existing report URLs without a viewer timezone", () => {
    expect(boxReportQuerySchema.parse({})).toEqual({ timeZone: "UTC" });
    const html = renderBoxReportHtml(fixture({ openedAt: new Date("2026-09-09T21:58:00.000Z") }));
    expect(html).toContain("открыт 09.09.2026 21:58");
  });

  it.each(["Not/A_Time_Zone", "", "<script>", ["UTC", "Europe/Moscow"]])(
    "rejects invalid or repeated timezone values: %s",
    (timeZone) => {
      expect(boxReportQuerySchema.safeParse({ timeZone }).success).toBe(false);
    },
  );
```

на

<!-- prettier-ignore -->
```ts
  it("prints UTC when no viewer timezone is given", () => {
    const html = renderBoxReportHtml(fixture({ openedAt: new Date("2026-09-09T21:58:00.000Z") }));
    expect(html).toContain("открыт 09.09.2026 21:58");
  });
```

Создать `apps/api/test/box-report-query.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { boxReportQuerySchema } from "../src/modules/code-search/dto";

describe("boxReportQuerySchema", () => {
  it("retains UTC for existing report URLs without a viewer timezone", () => {
    expect(boxReportQuerySchema.parse({})).toEqual({ timeZone: "UTC" });
  });

  it.each(["Not/A_Time_Zone", "", "<script>", ["UTC", "Europe/Moscow"]])(
    "rejects invalid or repeated timezone values: %s",
    (timeZone) => {
      expect(boxReportQuerySchema.safeParse({ timeZone }).success).toBe(false);
    },
  );
});
```

В `.prettierignore` заменить строку `apps/api/test/fixtures/print-forms/` на `packages/domain/test/fixtures/print-forms/`, а в комментарии над ней слова «while the forms move into @markiro/domain» — на «of the forms in @markiro/domain».

- [ ] **Step 7: Перевести браузерный контракт админки на исходник домена**

В `apps/admin/test/browser/box-report-render.mjs` заменить абзац комментария

```js
// The API imports its own modules without an extension (`./contents-report`),
// which its TypeScript build resolves and Node's ESM resolver does not. Only
// for a relative import from a TypeScript file that Node cannot find, retry the
// `.ts` source, so the API's import style and build stay untouched. Those
// sources are ES modules written in TypeScript; saying so spares Node a
// CommonJS attempt and the typeless-package warning for apps/api. The hook
// must be registered before the renderer loads, hence the dynamic import.
```

на

```js
// The domain package writes Node ESM imports with a `.js` suffix
// (`./contents-report.js`) that its TypeScript build maps to `.ts` files, which
// Node's resolver cannot find in source form. Only for a relative import from a
// TypeScript file that Node cannot find, retry the `.ts` source, so the
// package's import style and build stay untouched. Those sources are ES modules
// written in TypeScript; saying so spares Node a CommonJS attempt. The hook
// must be registered before the renderer loads, hence the dynamic import.
```

заменить функцию `resolveSource` целиком на

```js
function resolveSource(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    const relativeSourceImport =
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      /^\.\.?\//.test(specifier) &&
      context.parentURL?.endsWith(".ts");
    if (!relativeSourceImport) throw error;
    const source = specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : `${specifier}.ts`;
    return nextResolve(source, context);
  }
}
```

и строку импорта рендерера

```js
const { renderBoxReportHtml } = await import("../../../api/src/modules/code-search/box-report.ts");
```

на

```js
const { renderBoxReportHtml } =
  await import("../../../../packages/domain/src/print-forms/box-report.ts");
```

- [ ] **Step 8: Проверить домен: слепки без перезаписи и тесты рендера**

Run:

```bash
CI=true pnpm --filter @markiro/domain exec vitest run test/print-forms-snapshot.test.ts test/box-report.test.ts test/pallet-report.test.ts test/pallet-placard.test.ts test/shift-task-form.test.ts
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
```

Expected: все тесты PASS, в том числе 8 слепков (с `CI=true` Vitest не перезаписывает файлы, значит вывод побайтово совпал); typecheck, lint и build без ошибок.

- [ ] **Step 9: Проверить API**

Run:

```bash
CI=true pnpm --filter @markiro/api exec vitest run test/box-report-query.test.ts test/inventory-task-form.test.ts test/inventory-task-form-snapshot.test.ts test/shifts-openapi.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Expected: тесты PASS (`inventory-task-form-snapshot.test.ts` доказывает, что оформление бланка не сдвинулось ни на байт); typecheck, lint и build без ошибок. Тесты, требующие `DATABASE_URL`, в этом списке отсутствуют; если какой-то из них всё же пропущен — отметить это в отчёте.

- [ ] **Step 10: Проверить рендерер браузерного контракта напрямую**

Run:

```bash
printf '%s' '{"timeZone":"Europe/Moscow","data":{"sscc":"00146007034967000010","status":"closed","productName":"Молоко 1л","org":null,"openedAt":"2026-09-09T21:58:00.000Z","closedAt":"2026-09-09T22:08:00.000Z","disassembledAt":null,"codes":[]}}' | node apps/admin/test/browser/box-report-render.mjs | grep -o "открыт 10.09.2026 00:58"
```

Expected: вывод `открыт 10.09.2026 00:58` (модуль разрешился из исходников домена, часовой пояс применён). Полный браузерный контракт (`pnpm --dir tools/production-browser --ignore-workspace test:product-labels`) требует поднятого production-бандла и выполняется в CI в задании `production-bundle`; локально его не запускать и в отчёте указать как не выполненный.

- [ ] **Step 11: Прочие проверки и commit**

Run:

```bash
grep -rn --include='*.ts' --include='*.tsx' --include='*.mjs' -E "modules/(code-search/(contents-report|box-report|pallet-report|pallet-placard)|print/task-form-chrome|shifts/shift-task-form)" apps packages tools | grep -v -E "node_modules|/dist/" || echo "no stale imports"
node_modules/.bin/prettier --check .prettierignore packages/domain/src/index.ts packages/domain/src/print-forms packages/domain/test apps/api/src/modules/code-search apps/api/src/modules/shifts apps/api/src/modules/inventories/inventory-task-form.ts apps/api/test/box-report-query.test.ts apps/admin/test/browser/box-report-render.mjs
git diff --check
```

Expected: «no stale imports»; Prettier без замечаний (при замечаниях — `node_modules/.bin/prettier --write` по тем же путям, кроме каталога слепков, и повторить); `git diff --check` без вывода.

```bash
git add -A packages/domain/src/print-forms packages/domain/src/index.ts packages/domain/test apps/api/src/modules/code-search apps/api/src/modules/shifts apps/api/src/modules/print apps/api/src/modules/inventories/inventory-task-form.ts apps/api/test apps/admin/test/browser/box-report-render.mjs .prettierignore
git status --short
git commit -m "refactor(domain): печатные формы переезжают в @markiro/domain" -m "Состав короба и паллеты, ярлык паллеты, бланк смены и общее оформление бланков теперь в packages/domain/src/print-forms; API, форма инвентаризации и браузерный контракт админки берут их оттуда. Вывод побайтово тот же: слепки из предыдущего коммита проходят с CI=true." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Перед коммитом убедиться по `git status --short`, что в индексе только перечисленные пути.

---

### Task 3: Документация

**Files:**

- Modify: `docs/architecture.md` (раздел 1, строка про `domain/`)
- Modify: `AGENTS.md` (карта репозитория, строка про `packages/domain`)

**Interfaces:**

- Consumes: результат задачи 2.
- Produces: актуальное описание состава домена.

- [ ] **Step 1: Обновить описание домена в архитектуре**

В `docs/architecture.md` заменить

```
  domain/     GS1 validation, SSCC, ZPL/TSPL generation, Cyrillic
              rasterization, export formats — shared by api/admin/station
```

на

```
  domain/     GS1 validation, SSCC, ZPL/TSPL generation, Cyrillic
              rasterization, export formats, printable A4/A5 forms
              — shared by api/admin/station
```

- [ ] **Step 2: Обновить карту репозитория**

В `AGENTS.md` заменить

```
- `packages/domain`: shared GS1/KM/GTIN/SSCC validation, label models,
  ZPL/TSPL, rasterization, and other framework-independent rules.
```

на

```
- `packages/domain`: shared GS1/KM/GTIN/SSCC validation, label models,
  ZPL/TSPL, rasterization, printable A4/A5 forms, and other
  framework-independent rules.
```

- [ ] **Step 3: Проверить и закоммитить**

Run:

```bash
node_modules/.bin/prettier --check docs/architecture.md AGENTS.md
git diff --check
git add docs/architecture.md AGENTS.md
git commit -m "docs: печатные формы теперь часть @markiro/domain" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: Prettier без замечаний, коммит создан.

---

## Итоговая проверка этапа

- [ ] `CI=true pnpm --filter @markiro/domain test` — весь пакет домена PASS.
- [ ] `pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint && pnpm --filter @markiro/domain build`.
- [ ] `pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint && pnpm --filter @markiro/api build`.
- [ ] `CI=true pnpm --filter @markiro/api exec vitest run test/box-report-query.test.ts test/inventory-task-form.test.ts test/inventory-task-form-snapshot.test.ts test/shifts-openapi.test.ts`.
- [ ] `pnpm --filter @markiro/admin typecheck` (контракт `.mjs` не типизируется, но админка зависит от домена).
- [ ] В отчёте отдельно: браузерный контракт `test:product-labels` и e2e-тесты API с базой данных локально не запускались (нужны production-бандл и `DATABASE_URL`); они выполняются в CI.
