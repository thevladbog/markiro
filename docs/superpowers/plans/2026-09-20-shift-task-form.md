# Shift Task Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Печатный A4-бланк смены с DataMatrix, который на станции и на ТСД открывает смену одним сканированием.

**Architecture:** Формат токена штрихкода живёт в `@markiro/domain` и повторяется на Kotlin для ТСД. API отдаёт самодостаточный HTML-бланк через новый маршрут, построенный на каркасе печатных бланков, который выделяется из формы-задания инвентаризации без единого изменения её вывода. Терминалы разбирают штрихкод локально по уже загруженному списку `GET /shifts` и входят существующими путями входа; новых эндпоинтов устройства нет.

**Tech Stack:** TypeScript (NestJS, Drizzle, React, Vitest), Kotlin/Compose (Android, JUnit), Postgres.

Спека: [docs/superpowers/specs/2026-09-20-shift-task-form-design.md](../specs/2026-09-20-shift-task-form-design.md).

## Global Constraints

- Токен штрихкода: строка `markiro:shift:v1:<uuid>`. Префикс `markiro:shift:v1:` — ровно эта строка, без изменений регистра и пробелов.
- Бланк отдаётся только для смен в статусе `planned` и `active`. Для `closed` — 409 с кодом `SHIFT_TASK_FORM_CLOSED`.
- Язык бланка — только русский. Локализуются (ru/en) лишь кнопка в админке, сообщения станции и строки ТСД.
- HTML формы-задания инвентаризации (`renderInventoryTaskFormHtml`) обязан остаться байт-в-байт прежним после выделения каркаса.
- TypeScript строгий: включены `noUncheckedIndexedAccess` и `exactOptionalPropertyTypes`. Никаких `any`, `!` и широких приведений.
- `@markiro/domain`, `@markiro/db` и `@markiro/platform-contracts` экспортируют собранный `dist`. После изменения исходников пакета собрать его до тестов потребителей.
- ТСД поставляет строки парой: `app/src/main/res/values/strings.xml` и `app/src/main/res/values-en/strings.xml`.
- Все коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

**Создаются:**

| Файл | Ответственность |
| --- | --- |
| `packages/domain/src/barcodes/task-tokens.ts` | Формат и разбор токена бланка смены |
| `packages/domain/test/task-tokens.test.ts` | Тесты формата и разбора |
| `apps/api/src/modules/print/task-form-chrome.ts` | Общий каркас печатных бланков: логотип, экранирование, форматы, склонения, базовый CSS |
| `apps/api/src/modules/shifts/shift-task-form.ts` | Чистый рендерер HTML бланка смены |
| `apps/api/test/shift-task-form.test.ts` | Тесты рендерера бланка смены |
| `apps/api/test/fixtures/inventory-task-form.snapshot.html` | Эталон вывода бланка инвентаризации |
| `apps/api/test/inventory-task-form-snapshot.test.ts` | Проверка байтовой идентичности бланка инвентаризации |
| `packages/db/migrations/0167_shift_entry_method.sql` | Колонка `entry_method` |
| `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/barcode/ShiftTaskToken.kt` | Kotlin-разбор токена |
| `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/barcode/ShiftTaskTokenTest.kt` | Тесты Kotlin-разбора |

**Изменяются:** `packages/domain/src/index.ts`, `apps/api/src/modules/inventories/inventory-task-form.ts`, `apps/api/src/modules/shifts/{shifts.controller.ts,shifts.service.ts,dto.ts}`, `apps/api/test/{shifts-openapi.test.ts,shifts.e2e.test.ts}`, `packages/db/src/schema/platform.ts`, `apps/admin/src/pages/shifts/ShiftDetailsPanel.tsx`, `apps/admin/src/i18n/{ru,en}.json`, `apps/station/src/pages/{ShiftSelection.tsx,TaskSelection.tsx}`, `apps/station/src/i18n/{ru,en}.json`, `apps/station/src/station.css`, `apps/handheld/.../feature/shift/{ShiftListViewModel.kt,ShiftRepository.kt}`, `apps/handheld/.../core/network/{StationApi.kt,Dtos.kt}`, `apps/handheld/app/src/main/res/values{,-en}/strings.xml`.

---

## Task 1: Токен бланка смены в домене

**Files:**
- Create: `packages/domain/src/barcodes/task-tokens.ts`
- Create: `packages/domain/test/task-tokens.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `SHIFT_TASK_BARCODE_PREFIX: "markiro:shift:v1:"`, `formatShiftTaskBarcode(shiftId: string): string`, `parseShiftTaskBarcode(barcode: string): string | null`. Все три экспортируются из `@markiro/domain`.

- [ ] **Step 1: Написать падающий тест**

Создать `packages/domain/test/task-tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  formatShiftTaskBarcode,
  parseShiftTaskBarcode,
  SHIFT_TASK_BARCODE_PREFIX,
} from "../src/barcodes/task-tokens.js";

const SHIFT_ID = "11111111-1111-4111-8111-111111111111";

describe("shift task barcode", () => {
  it("prefixes the shift id with the frozen v1 namespace", () => {
    expect(SHIFT_TASK_BARCODE_PREFIX).toBe("markiro:shift:v1:");
    expect(formatShiftTaskBarcode(SHIFT_ID)).toBe(`markiro:shift:v1:${SHIFT_ID}`);
  });

  it("round-trips its own output", () => {
    expect(parseShiftTaskBarcode(formatShiftTaskBarcode(SHIFT_ID))).toBe(SHIFT_ID);
  });

  it("refuses another namespace so an inventory form never opens a shift", () => {
    expect(parseShiftTaskBarcode(`markiro:inventory:v1:${SHIFT_ID}`)).toBeNull();
  });

  it("refuses a well-prefixed payload that is not a uuid", () => {
    expect(parseShiftTaskBarcode("markiro:shift:v1:not-a-uuid")).toBeNull();
    expect(parseShiftTaskBarcode("markiro:shift:v1:")).toBeNull();
  });

  it("refuses a bare uuid and unrelated production scans", () => {
    expect(parseShiftTaskBarcode(SHIFT_ID)).toBeNull();
    expect(parseShiftTaskBarcode("010468008990038321ABC93XYZ")).toBeNull();
  });

  it("normalises an uppercase uuid so one shift has one identity", () => {
    expect(parseShiftTaskBarcode(`markiro:shift:v1:${SHIFT_ID.toUpperCase()}`)).toBe(SHIFT_ID);
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/domain exec vitest run test/task-tokens.test.ts
```

Ожидается: FAIL, `Cannot find module '../src/barcodes/task-tokens.js'`.

- [ ] **Step 3: Написать реализацию**

Создать `packages/domain/src/barcodes/task-tokens.ts`:

```ts
import { z } from "zod";

/**
 * Frozen v1 namespace for the printed shift task form's Data Matrix.
 *
 * The prefix lives in the domain rather than beside the API's shift DTOs
 * because three implementations read it: the API renders it, the Station
 * parses it locally against its loaded shift list, and the handheld repeats
 * the rule in Kotlin. A second copy of the literal is how the three drift.
 */
export const SHIFT_TASK_BARCODE_PREFIX = "markiro:shift:v1:";

const shiftIdSchema = z.uuid().toLowerCase();

export function formatShiftTaskBarcode(shiftId: string): string {
  return `${SHIFT_TASK_BARCODE_PREFIX}${shiftId}`;
}

/**
 * The shift id carried by a task-form barcode, or null when this scan is not
 * one. Null is the answer for every non-shift scan a terminal sees, so it is
 * a return value and not an exception.
 */
export function parseShiftTaskBarcode(barcode: string): string | null {
  if (!barcode.startsWith(SHIFT_TASK_BARCODE_PREFIX)) return null;
  const parsed = shiftIdSchema.safeParse(barcode.slice(SHIFT_TASK_BARCODE_PREFIX.length));
  return parsed.success ? parsed.data : null;
}
```

- [ ] **Step 4: Экспортировать из индекса пакета**

В `packages/domain/src/index.ts` найти блок экспорта `./barcodes/svg.js` (около строки 165) и добавить сразу после него:

```ts
export {
  formatShiftTaskBarcode,
  parseShiftTaskBarcode,
  SHIFT_TASK_BARCODE_PREFIX,
} from "./barcodes/task-tokens.js";
```

- [ ] **Step 5: Прогнать тест и убедиться, что он проходит**

```bash
pnpm --filter @markiro/domain exec vitest run test/task-tokens.test.ts
```

Ожидается: PASS, 6 тестов.

- [ ] **Step 6: Прогнать пакетные гейты**

```bash
pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint && pnpm --filter @markiro/domain build
```

Ожидается: все четыре команды завершаются кодом 0.

- [ ] **Step 7: Коммит**

```bash
git add packages/domain/src/barcodes/task-tokens.ts packages/domain/test/task-tokens.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): токен штрихкода бланка смены

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Каркас печатных бланков без изменения бланка инвентаризации

**Files:**
- Create: `apps/api/test/fixtures/inventory-task-form.snapshot.html`
- Create: `apps/api/test/inventory-task-form-snapshot.test.ts`
- Create: `apps/api/src/modules/print/task-form-chrome.ts`
- Modify: `apps/api/src/modules/inventories/inventory-task-form.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: из `apps/api/src/modules/print/task-form-chrome.ts` — `escapeHtml(value: string): string`, `boundPrintText(value: string): string`, `formatCivilDate(value: string): string`, `formatGeneratedAt(value: Date): string`, `formatInteger(value: number): string`, `countNoun(value: number, one: string, few: string, many: string): string`, `taskFormLogoSvg(): string`, `taskFormParameter(label: string, value: string): string`, `taskFormStep(number: number, text: string): string`, `TASK_FORM_BASE_CSS: string`.

Смысл задачи: сначала зафиксировать текущий вывод как эталон, потом переносить. Эталон — страховка, а не украшение: скриншот `task-form.png` печатной инструкции MKR-INS-06 снимается с этого HTML через `apps/admin/test/browser/task-form-harness.ts`.

- [ ] **Step 1: Снять эталон текущего вывода**

```bash
pnpm --filter @markiro/api exec tsx -e '
import { writeFileSync, mkdirSync } from "node:fs";
import { renderInventoryTaskFormHtml } from "./src/modules/inventories/inventory-task-form";
mkdirSync("test/fixtures", { recursive: true });
writeFileSync("test/fixtures/inventory-task-form.snapshot.html", renderInventoryTaskFormHtml({
  inventoryId: "11111111-1111-4111-8111-111111111111",
  inventoryNumber: "IVN-26-0042",
  status: "ready",
  organizationName: "ООО «Пивоварня»",
  productName: "Пиво светлое 0,45 л",
  gtin14: "04680089900383",
  lineName: "Упаковка А",
  mode: "repack",
  productionDateFrom: "2025-09-01",
  productionDateTo: "2025-12-31",
  expectedCount: 4116,
  boxCapacity: 20,
  generatedAt: new Date("2026-08-24T14:40:00.000Z"),
}), "utf8");
'
```

Ожидается: файл `apps/api/test/fixtures/inventory-task-form.snapshot.html` создан и непустой. Если `tsx` недоступен, тот же код выполнить через `pnpm --filter @markiro/api exec vitest run` во временном тесте — важен только файл на диске.

- [ ] **Step 2: Написать тест байтовой идентичности**

Создать `apps/api/test/inventory-task-form-snapshot.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  renderInventoryTaskFormHtml,
  type InventoryTaskFormData,
} from "../src/modules/inventories/inventory-task-form";

/**
 * The printed inventory task form is a published artefact: MKR-INS-06's
 * `task-form.png` is screenshotted from this exact HTML. Extracting shared
 * print chrome for the shift form must not move a single byte of it, so this
 * fixture is a characterisation lock rather than a readability aid.
 */
const SNAPSHOT = readFileSync(
  join(__dirname, "fixtures", "inventory-task-form.snapshot.html"),
  "utf8",
);

const FIXTURE: InventoryTaskFormData = {
  inventoryId: "11111111-1111-4111-8111-111111111111",
  inventoryNumber: "IVN-26-0042",
  status: "ready",
  organizationName: "ООО «Пивоварня»",
  productName: "Пиво светлое 0,45 л",
  gtin14: "04680089900383",
  lineName: "Упаковка А",
  mode: "repack",
  productionDateFrom: "2025-09-01",
  productionDateTo: "2025-12-31",
  expectedCount: 4_116,
  boxCapacity: 20,
  generatedAt: new Date("2026-08-24T14:40:00.000Z"),
};

describe("inventory task form byte lock", () => {
  it("renders exactly the bytes MKR-INS-06 was screenshotted from", () => {
    expect(renderInventoryTaskFormHtml(FIXTURE)).toBe(SNAPSHOT);
  });
});
```

- [ ] **Step 3: Прогнать тест и убедиться, что он проходит до переноса**

```bash
pnpm --filter @markiro/api exec vitest run test/inventory-task-form-snapshot.test.ts
```

Ожидается: PASS. Тест обязан быть зелёным ДО рефакторинга — иначе эталон снят неверно и дальше проверять нечего.

- [ ] **Step 4: Выделить каркас**

Создать `apps/api/src/modules/print/task-form-chrome.ts`. Перенести в него из `apps/api/src/modules/inventories/inventory-task-form.ts` функции `boundPrintText`, `escapeHtml`, `formatCivilDate`, `formatGeneratedAt`, `formatInteger`, `countNoun`, `logo`, `parameter`, `step` и константу `PRINT_TEXT_MAX_CODE_POINTS` **дословно**, переименовав три последние в `taskFormLogoSvg`, `taskFormParameter`, `taskFormStep` и добавив `export`:

```ts
/**
 * Print chrome shared by every A4 task form: the inventory task form and the
 * shift task form. Two forms that a factory holds side by side must not drift
 * in logo, date format or hairline weight, and the only way to guarantee that
 * is one source for both.
 */

const PRINT_TEXT_MAX_CODE_POINTS = 200;

export function boundPrintText(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= PRINT_TEXT_MAX_CODE_POINTS) return value;
  return `${codePoints.slice(0, PRINT_TEXT_MAX_CODE_POINTS - 1).join("")}…`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatCivilDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

export function formatGeneratedAt(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(value)
    .replace(",", "");
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value).replaceAll("\u00a0", "&nbsp;");
}

export function countNoun(value: number, one: string, few: string, many: string): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 < 11 || mod100 > 14) {
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
  }
  return many;
}

export function taskFormLogoSvg(): string {
  return `<svg class="brand-logo" data-brand-logo="markiro" viewBox="0 0 280 64" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Маркиро" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="56" height="56" fill="#17161A"/>
    <g fill="#FFFFFF">
      <rect x="14" y="14" width="8" height="8"/><rect x="14" y="26" width="8" height="8"/><rect x="14" y="38" width="8" height="8"/>
      <rect x="26" y="22" width="8" height="8"/><rect x="38" y="14" width="8" height="8"/><rect x="38" y="26" width="8" height="8"/>
      <rect x="38" y="38" width="8" height="8"/><rect x="26" y="42" width="8" height="8" fill="#3DDC7A"/>
    </g>
    <text x="76" y="45" font-family="Arial, sans-serif" font-weight="700" font-size="34" fill="#17161A">маркиро</text>
  </svg>`;
}

export function taskFormParameter(label: string, value: string): string {
  return `<div class="parameter"><dt>${label}</dt><dd>${value}</dd></div>`;
}

export function taskFormStep(number: number, text: string): string {
  return `<li><span class="step-number">${number}</span><span>${text}</span></li>`;
}
```

Затем в тот же файл добавить `TASK_FORM_BASE_CSS` — строку, содержащую содержимое блока `<style>` из `inventory-task-form.ts`, строки **151-215 включительно** (от `@page { size: A4 portrait; margin: 0; }` до `@media print { html, body { background: #fff; } .page { margin: 0; box-shadow: none; } }`), **скопированное символ в символ вместе с переводами строк и ведущими четырьмя пробелами каждой строки**. Не переформатировать, не сортировать правила, не менять регистр: тест из шага 3 сравнивает байты:

```ts
/**
 * The exact stylesheet the inventory task form shipped with, byte for byte.
 * `inventory-task-form-snapshot.test.ts` fails on any drift here, because the
 * published MKR-INS-06 screenshot was taken from these rules.
 */
export const TASK_FORM_BASE_CSS = `    @page { size: A4 portrait; margin: 0; }
…всё остальное без изменений…
    @media print { html, body { background: #fff; } .page { margin: 0; box-shadow: none; } }`;
```

- [ ] **Step 5: Перевести бланк инвентаризации на каркас**

В `apps/api/src/modules/inventories/inventory-task-form.ts` удалить перенесённые функции и константу, добавить импорт и подставить `TASK_FORM_BASE_CSS` внутрь `<style>`:

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

Локальные вызовы `logo()`, `parameter(...)`, `step(...)` заменить на `taskFormLogoSvg()`, `taskFormParameter(...)`, `taskFormStep(...)`. Блок `<style>` заменить на:

```
  <style>
${TASK_FORM_BASE_CSS}
  </style>
```

- [ ] **Step 6: Прогнать замок и тесты бланка инвентаризации**

```bash
pnpm --filter @markiro/api exec vitest run test/inventory-task-form-snapshot.test.ts test/inventory-task-form.test.ts
```

Ожидается: PASS, оба файла. Красный `inventory task form byte lock` означает, что при переносе сдвинулся пробел или перевод строки — чинить перенос, а не эталон.

- [ ] **Step 7: Коммит**

```bash
git add apps/api/src/modules/print/task-form-chrome.ts apps/api/src/modules/inventories/inventory-task-form.ts apps/api/test/inventory-task-form-snapshot.test.ts apps/api/test/fixtures/inventory-task-form.snapshot.html
git commit -m "refactor(api): общий каркас печатных бланков-заданий

Вывод бланка инвентаризации заперт побайтово: с него снимается
task-form.png для MKR-INS-06.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Рендерер бланка смены

**Files:**
- Create: `apps/api/src/modules/shifts/shift-task-form.ts`
- Create: `apps/api/test/shift-task-form.test.ts`

**Interfaces:**
- Consumes: `formatShiftTaskBarcode` из `@markiro/domain` (Task 1); `TASK_FORM_BASE_CSS`, `taskFormLogoSvg`, `taskFormParameter`, `taskFormStep`, `escapeHtml`, `boundPrintText`, `formatCivilDate`, `formatGeneratedAt`, `formatInteger`, `countNoun` из `../print/task-form-chrome` (Task 2).
- Produces: `interface ShiftTaskFormData` и `renderShiftTaskFormHtml(data: ShiftTaskFormData): string`.

`ShiftTaskFormData` (потребляется Task 4):

```ts
export interface ShiftTaskFormData {
  shiftId: string;
  shiftNumber: string;
  status: "planned" | "active";
  mode: "validation" | "aggregation";
  organizationName: string;
  productId: string;
  productName: string;
  productPrintName: string | null;
  gtin14: string;
  imageChecksum: string | null;
  lineName: string | null;
  plannedDate: string | null;
  productionDate: string | null;
  plannedQty: number | null;
  boxCapacity: number | null;
  palletsEnabled: boolean;
  palletBoxCapacity: number | null;
  counterpartyName: string | null;
  ssccIssuerName: string | null;
  validationPrintMode: "none" | "duplicate_dm";
  validationPrintVerification: "none" | "required";
  allowPreviouslyAcceptedCodes: boolean;
  generatedAt: Date;
}
```

- [ ] **Step 1: Написать падающий тест**

Создать `apps/api/test/shift-task-form.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  renderShiftTaskFormHtml,
  type ShiftTaskFormData,
} from "../src/modules/shifts/shift-task-form";

const SHIFT_ID = "22222222-2222-4222-8222-222222222222";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

function fixture(overrides: Partial<ShiftTaskFormData> = {}): ShiftTaskFormData {
  return {
    shiftId: SHIFT_ID,
    shiftNumber: "SEP26-014",
    status: "planned",
    mode: "aggregation",
    organizationName: "ООО «Атолл»",
    productId: PRODUCT_ID,
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
    ...overrides,
  };
}

describe("renderShiftTaskFormHtml", () => {
  it("carries the station token and the human shift number as separate identities", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toContain(`data-task-token="markiro:shift:v1:${SHIFT_ID}"`);
    expect(html).toContain("SEP26-014");
    expect(html).toContain("Отсканируйте на терминале, чтобы открыть смену");
  });

  it("renders the token as a compact Data Matrix, not a stretched one", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toContain('data-barcode-symbology="datamatrix"');
    expect(html).not.toContain('preserveAspectRatio="none"');
  });

  it("prints aggregation parameters and hides validation printing ones", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toContain("ВМЕСТИМОСТЬ КОРОБА");
    expect(html).toContain("24 бутылки");
    expect(html).toContain("Собираются, 40 коробов");
    expect(html).toContain("Собственные");
    expect(html).not.toContain("ПЕЧАТЬ ЭТИКЕТКИ");
  });

  it("prints the issuing counterparty when the boxes carry someone else's numbers", () => {
    const html = renderShiftTaskFormHtml(fixture({ ssccIssuerName: "ООО «Ромашка»" }));

    expect(html).toContain("ООО «Ромашка»");
    expect(html).not.toContain(">Собственные<");
  });

  it("prints validation printing parameters and hides aggregation ones", () => {
    const html = renderShiftTaskFormHtml(
      fixture({
        mode: "validation",
        palletsEnabled: false,
        palletBoxCapacity: null,
        boxCapacity: null,
        validationPrintMode: "duplicate_dm",
        validationPrintVerification: "required",
        allowPreviouslyAcceptedCodes: true,
      }),
    );

    expect(html).toContain("ПЕЧАТЬ ЭТИКЕТКИ");
    expect(html).toContain("Дубликат Data Matrix · обязательная проверка");
    expect(html).toContain("ПОВТОРНАЯ ОБРАБОТКА");
    expect(html).not.toContain("ВМЕСТИМОСТЬ КОРОБА");
    expect(html).not.toContain("ПАЛЛЕТЫ");
  });

  it("omits the reprocessing row when reprocessing is off", () => {
    const html = renderShiftTaskFormHtml(
      fixture({ mode: "validation", validationPrintMode: "duplicate_dm" }),
    );

    expect(html).not.toContain("ПОВТОРНАЯ ОБРАБОТКА");
  });

  it("references the product photo relatively so both origins resolve it", () => {
    const html = renderShiftTaskFormHtml(fixture());

    expect(html).toContain(`src="../../products/${PRODUCT_ID}/image/${"a".repeat(64)}"`);
  });

  it("drops the photo box entirely when the product has no image", () => {
    const html = renderShiftTaskFormHtml(fixture({ imageChecksum: null }));

    expect(html).not.toContain("<img");
    expect(html).toContain("Вода питьевая «Атолл» негазированная, ПЭТ 0,5 л");
  });

  it("names the defaults a shop floor needs instead of printing dashes", () => {
    const html = renderShiftTaskFormHtml(
      fixture({ lineName: null, productionDate: null, plannedQty: null }),
    );

    expect(html).toContain("Не назначена");
    expect(html).toContain("По дате смены");
    expect(html).toContain("Без плана");
  });

  it("labels both printable statuses", () => {
    expect(renderShiftTaskFormHtml(fixture())).toContain("К запуску");
    expect(renderShiftTaskFormHtml(fixture({ status: "active" }))).toContain("В работе");
  });

  it("escapes tenant-controlled text instead of interpolating markup", () => {
    const html = renderShiftTaskFormHtml(
      fixture({ productName: '<script>alert("x")</script>', counterpartyName: "A & B" }),
    );

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
  });

  it("is deterministic for the same input", () => {
    expect(renderShiftTaskFormHtml(fixture())).toBe(renderShiftTaskFormHtml(fixture()));
  });

  it("switches to the compact layout when the names would overflow one page", () => {
    const html = renderShiftTaskFormHtml(
      fixture({ productName: "П".repeat(150), counterpartyName: "К".repeat(120) }),
    );

    expect(html).toContain('data-layout="compact"');
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/api exec vitest run test/shift-task-form.test.ts
```

Ожидается: FAIL, `Cannot find module '../src/modules/shifts/shift-task-form'`.

- [ ] **Step 3: Написать реализацию**

Создать `apps/api/src/modules/shifts/shift-task-form.ts`. Каркас файла:

```ts
import { formatShiftTaskBarcode, renderLiteralDataMatrixSvg } from "@markiro/domain";

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

export interface ShiftTaskFormData {
  /* поля из блока Interfaces этой задачи, все 23, в том же порядке */
}

const STATUS_LABEL: Record<ShiftTaskFormData["status"], string> = {
  planned: "К запуску",
  active: "В работе",
};

const SHIFT_FORM_CSS = `    .product { … правила из этого шага … }`;

export function renderShiftTaskFormHtml(data: ShiftTaskFormData): string {
  const number = escapeHtml(data.shiftNumber);
  const token = formatShiftTaskBarcode(data.shiftId);
  const barcode = renderLiteralDataMatrixSvg(token);
  const organizationText = boundPrintText(data.organizationName);
  const productText = boundPrintText(data.productName);
  const lineText = data.lineName === null ? "" : boundPrintText(data.lineName);
  const counterpartyText =
    data.counterpartyName === null ? "" : boundPrintText(data.counterpartyName);
  const compact =
    organizationText.length + productText.length + lineText.length + counterpartyText.length >
      240 ||
    [organizationText, productText, lineText, counterpartyText].some(
      (value) => value.length > 100,
    );
  const aggregation = data.mode === "aggregation";
  const modeTitle = aggregation
    ? data.palletsEnabled
      ? "Агрегация с паллетами"
      : "Агрегация"
    : "Проверка";

  /* значения параметров — блок кода ниже в этом же шаге */

  const parameters = [
    taskFormParameter("ЛИНИЯ", line),
    taskFormParameter("ДАТА СМЕНЫ", shiftDate),
    taskFormParameter("ДАТА ПРОИЗВОДСТВА", productionDate),
    taskFormParameter("ПЛАН", plan),
    ...(aggregation
      ? [
          taskFormParameter("ВМЕСТИМОСТЬ КОРОБА", boxes),
          taskFormParameter("ПАЛЛЕТЫ", pallets),
          taskFormParameter("НОМЕРА SSCC", issuer),
        ]
      : [
          taskFormParameter("ПЕЧАТЬ ЭТИКЕТКИ", printing),
          ...(data.allowPreviouslyAcceptedCodes
            ? [taskFormParameter("ПОВТОРНАЯ ОБРАБОТКА", "Коды прошлых смен разрешены")]
            : []),
        ]),
    ...(data.counterpartyName === null
      ? []
      : [taskFormParameter("ДЛЯ КОНТРАГЕНТА", escapeHtml(counterpartyText))]),
  ].join("");

  const photo =
    data.imageChecksum === null
      ? ""
      : `<div class="product-photo"><img src="../../products/${escapeHtml(data.productId)}/image/${escapeHtml(data.imageChecksum)}" alt=""></div>`;

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Бланк смены ${number}</title>
  <style>
${TASK_FORM_BASE_CSS}
${SHIFT_FORM_CSS}
  </style>
</head>
<body>
  <main class="page${compact ? " compact" : ""}" data-layout="${compact ? "compact" : "standard"}">
    <header class="top">${taskFormLogoSvg()}<div class="task-id"><span class="eyebrow">Бланк смены</span><strong>${number}</strong></div></header>
    <section class="task-passport">…паспорт, как описано ниже…</section>
    <section class="product${data.imageChecksum === null ? " product--no-photo" : ""}">…</section>
    <section class="parameters"><h2>Параметры смены</h2><dl>${parameters}</dl></section>
    <section class="steps"><h2>Как начать работу</h2><ol>…</ol></section>
    <aside class="rules"><h2>Важные правила</h2><ul>…</ul></aside>
    <section class="comments" aria-label="Комментарии оператора"><div class="comments-header"><h2>Комментарии оператора</h2><span>Простои · номера коробов · замечания</span></div></section>
    <footer class="footer"><span>Сформировано: ${formatGeneratedAt(data.generatedAt)} · Маркиро</span><span>${number} · 1 / 1</span></footer>
  </main>
</body>
</html>`;
}
```

Классы разметки (`page`, `top`, `task-id`, `eyebrow`, `task-passport`, `hero`, `status`, `scan-zone`, `barcode`, `barcode-caption`, `scan-hint`, `parameters`, `steps`, `rules`, `comments`, `comments-header`, `footer`, `compact`) берутся из `TASK_FORM_BASE_CSS` — новых имён для них не вводить.

Обязательные элементы вывода:

- `<style>` содержит `${TASK_FORM_BASE_CSS}`, затем собственные правила бланка смены:

```css
    .product { display: grid; grid-template-columns: 28mm minmax(0, 1fr); gap: 5mm; align-items: center; padding: 5mm 0 4mm; border-bottom: .2mm solid #d8d5cf; }
    .product--no-photo { grid-template-columns: minmax(0, 1fr); }
    .product-photo { width: 28mm; height: 28mm; border: .2mm solid #d8d5cf; background: #f1efe8; overflow: hidden; }
    .product-photo img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .product-eyebrow { color: #706d67; font-size: 8pt; letter-spacing: .03em; text-transform: uppercase; }
    .product-name { margin-top: 1mm; font-size: 12pt; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
    .product-meta { margin-top: 1mm; color: #4f4c47; font-size: 9pt; }
    .product-meta strong, .product-meta span { font-weight: 700; }
    .compact .product { grid-template-columns: 22mm minmax(0, 1fr); gap: 4mm; padding: 3mm 0; }
    .compact .product--no-photo { grid-template-columns: minmax(0, 1fr); }
    .compact .product-photo { width: 22mm; height: 22mm; }
    .compact .product-name { font-size: 10pt; }
    .compact .product-meta { font-size: 8pt; }
```

- шапка: `taskFormLogoSvg()` и `<span class="eyebrow">Бланк смены</span>` + номер;
- паспорт: `<h1>Сменное задание</h1>`, подзаголовок `«<режим> · <организация>»`, плашка статуса из карты `{ planned: "К запуску", active: "В работе" }`, зона сканирования с `data-barcode-symbology="datamatrix"`, `data-task-token="${escapeHtml(token)}"` и `renderLiteralDataMatrixSvg(token)`, подсказкой «Отсканируйте на терминале, чтобы открыть смену»;
- блок продукции: при `imageChecksum !== null` — `<img src="../../products/${escapeHtml(productId)}/image/${escapeHtml(imageChecksum)}" alt="">`, иначе класс `product--no-photo` и никакого `<img>`; далее наименование, строка `На терминале: <strong>…</strong> · GTIN <span>…</span>` (короткое имя печатается только при `productPrintName !== null`);
- параметры через `taskFormParameter`, ровно в этом порядке: `ЛИНИЯ`, `ДАТА СМЕНЫ`, `ДАТА ПРОИЗВОДСТВА`, `ПЛАН`, затем для `aggregation` — `ВМЕСТИМОСТЬ КОРОБА`, `ПАЛЛЕТЫ`, `НОМЕРА SSCC`, а для `validation` — `ПЕЧАТЬ ЭТИКЕТКИ` и, только при `allowPreviouslyAcceptedCodes === true`, `ПОВТОРНАЯ ОБРАБОТКА`; в конце, при `counterpartyName !== null`, — `ДЛЯ КОНТРАГЕНТА`.

Значения параметров:

```ts
const line = data.lineName === null ? "Не назначена" : escapeHtml(boundPrintText(data.lineName));
const shiftDate = data.plannedDate === null ? "Не назначена" : formatCivilDate(data.plannedDate);
const productionDate =
  data.productionDate === null ? "По дате смены" : formatCivilDate(data.productionDate);
const plan =
  data.plannedQty === null
    ? "Без плана"
    : `${formatInteger(data.plannedQty)} ${countNoun(data.plannedQty, "единица", "единицы", "единиц")}`;
const boxes =
  data.boxCapacity === null
    ? "Не задана"
    : `${formatInteger(data.boxCapacity)} ${countNoun(data.boxCapacity, "бутылка", "бутылки", "бутылок")}`;
const pallets =
  !data.palletsEnabled || data.palletBoxCapacity === null
    ? "Не собираются"
    : `Собираются, ${formatInteger(data.palletBoxCapacity)} ${countNoun(data.palletBoxCapacity, "короб", "короба", "коробов")}`;
const issuer =
  data.ssccIssuerName === null ? "Собственные" : escapeHtml(boundPrintText(data.ssccIssuerName));
const printing =
  data.validationPrintMode === "none"
    ? "Без печати"
    : data.validationPrintVerification === "required"
      ? "Дубликат Data Matrix · обязательная проверка"
      : "Дубликат Data Matrix";
```

- признак `compact` считать по той же логике, что в бланке инвентаризации, но по своему набору строк:

```ts
const compact =
  organizationText.length + productText.length + lineText.length + counterpartyText.length > 240 ||
  [organizationText, productText, lineText, counterpartyText].some((value) => value.length > 100);
```

где каждая `*Text` — результат `boundPrintText` над соответствующим полем (для `null` — пустая строка);

- шаги «Как начать работу»: 1 — «Откройте терминал на линии «`<линия>`» и войдите оператором.» (при `lineName === null` — «Откройте терминал и войдите оператором.»), 2 — «Отсканируйте штрихкод бланка. На своей линии смена также видна в списке.», 3 — «Сверьте продукцию и дату производства на экране перед первым сканированием.», 4 — для `aggregation`: «Сканируйте коды единиц. Короб закроется и напечатается после `<N>`-го кода.» (при `boxCapacity === null` — «Сканируйте коды единиц. Короб закроется по заданной вместимости.»), для `validation`: «Сканируйте коды единиц. Смена принимает каждый код один раз.»;
- блок «Важные правила»: первым пунктом на всю ширину — «**Бланк отражает параметры на момент печати.** Если мастер изменил смену, терминал покажет актуальные значения — верьте экрану.»; далее для `aggregation` — пункт про закрытие паллеты (печатается только при `palletsEnabled && palletBoxCapacity !== null`), для `validation` при `validationPrintMode === "duplicate_dm"` — пункт про печать дубликата; затем общие: «Дата производства держится до следующего изменения; в одном коробе одна дата.», «Смену закрывает станция, которая её открыла. Вторая станция — только через админку.», «Чтобы поставить работу на паузу, выйдите из смены: она останется активной.»;
- блок комментариев оператора с подписью «Простои · номера коробов · замечания»;
- футер: `Сформировано: ${formatGeneratedAt(data.generatedAt)} · Маркиро` и `${number} · 1 / 1`.

- [ ] **Step 4: Прогнать тест и убедиться, что он проходит**

```bash
pnpm --filter @markiro/api exec vitest run test/shift-task-form.test.ts
```

Ожидается: PASS, 13 тестов.

- [ ] **Step 5: Убедиться, что бланк инвентаризации не сдвинулся**

```bash
pnpm --filter @markiro/api exec vitest run test/inventory-task-form-snapshot.test.ts
```

Ожидается: PASS.

- [ ] **Step 6: Коммит**

```bash
git add apps/api/src/modules/shifts/shift-task-form.ts apps/api/test/shift-task-form.test.ts
git commit -m "feat(api): рендерер печатного бланка смены

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Сбор данных и маршрут `GET /shifts/:id/task-form`

**Files:**
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts`
- Modify: `apps/api/test/shifts-openapi.test.ts`
- Modify: `apps/api/test/shifts.e2e.test.ts`

**Interfaces:**
- Consumes: `renderShiftTaskFormHtml`, `ShiftTaskFormData` (Task 3).
- Produces: `ShiftsService.taskFormData(tenantId: string, id: string, generatedAt?: Date): Promise<ShiftTaskFormData>`; маршрут `GET /shifts/:id/task-form`.

- [ ] **Step 1: Написать падающий e2e-тест**

Добавить в `apps/api/test/shifts.e2e.test.ts` (рядом с существующими тестами смен, используя принятый в файле способ создания смены и клиентов `owner` / станции):

```ts
it("serves the printable task form to a read-only administrator and refuses a closed shift", async () => {
  const shift = await createPlannedShift();

  const planned = await owner.get(`/shifts/${shift.id}/task-form`).expect(200);
  expect(planned.headers["content-type"]).toContain("text/html");
  expect(planned.headers["cache-control"]).toBe("private, no-store");
  expect(planned.text).toContain(`data-task-token="markiro:shift:v1:${shift.id}"`);
  expect(planned.text).toContain("К запуску");

  await owner.post(`/shifts/${shift.id}/open`).expect(200);
  const active = await owner.get(`/shifts/${shift.id}/task-form`).expect(200);
  expect(active.text).toContain("В работе");

  await owner.post(`/shifts/${shift.id}/close`).send({ reason: "done" }).expect(200);
  await owner
    .get(`/shifts/${shift.id}/task-form`)
    .expect(409, { code: "SHIFT_TASK_FORM_CLOSED" });
});

it("keeps the task form out of reach of a station credential and of another tenant", async () => {
  const shift = await createPlannedShift();

  await station.get(`/shifts/${shift.id}/task-form`).expect(403);
  await otherTenantOwner.get(`/shifts/${shift.id}/task-form`).expect(404);
});
```

Если в файле нет готовых `createPlannedShift` / `otherTenantOwner`, использовать те же приёмы, что соседние тесты этого файла: создать смену через `POST /shifts` и второго владельца через существующий помощник тенанта.

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/shifts.e2e.test.ts -t "task form"
```

Ожидается: FAIL со статусом 404 на первом запросе — маршрута ещё нет.

- [ ] **Step 3: Добавить сбор данных в сервис**

В `apps/api/src/modules/shifts/shifts.service.ts` добавить импорты:

```ts
import { alias } from "drizzle-orm/pg-core";

import { renderShiftTaskFormHtml, type ShiftTaskFormData } from "./shift-task-form";
```

и метод:

```ts
/**
 * Everything the printed shift task form shows, in one read.
 *
 * The SSCC issuer needs its own alias: `counterparties` is already joined for
 * "who is this shift for", and "whose numbers do its boxes carry" is a
 * different question with a different answer.
 */
async taskFormData(
  tenantId: string,
  id: string,
  generatedAt = new Date(),
): Promise<ShiftTaskFormData> {
  const issuer = alias(schema.counterparties, "sscc_issuer");
  const [row] = await this.db
    .select({
      id: schema.shifts.id,
      numberMonthKey: schema.shifts.numberMonthKey,
      numberSeq: schema.shifts.numberSeq,
      createdFrom: schema.shifts.createdFrom,
      status: schema.shifts.status,
      mode: schema.shifts.mode,
      plannedDate: schema.shifts.plannedDate,
      productionDate: schema.shifts.productionDate,
      plannedQty: schema.shifts.plannedQty,
      boxCapacity: schema.shifts.boxCapacity,
      palletsEnabled: schema.shifts.palletsEnabled,
      palletBoxCapacity: schema.shifts.palletBoxCapacity,
      validationPrintMode: schema.shifts.validationPrintMode,
      validationPrintVerification: schema.shifts.validationPrintVerification,
      allowPreviouslyAcceptedCodes: schema.shifts.allowPreviouslyAcceptedCodes,
      organizationName: schema.organization.name,
      productId: schema.products.id,
      productName: schema.products.name,
      productPrintName: schema.products.printName,
      gtin14: schema.products.gtin14,
      imageChecksum: schema.mediaAssets.checksum,
      lineName: schema.lines.name,
      counterpartyName: schema.counterparties.name,
      ssccIssuerName: issuer.name,
    })
    .from(schema.shifts)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.shifts.tenantId))
    .innerJoin(schema.products, eq(schema.products.id, schema.shifts.productId))
    .leftJoin(schema.lines, eq(schema.lines.id, schema.shifts.lineId))
    .leftJoin(schema.counterparties, eq(schema.counterparties.id, schema.shifts.counterpartyId))
    .leftJoin(issuer, eq(issuer.id, schema.shifts.ssccIssuerCounterpartyId))
    .leftJoin(
      schema.productImages,
      and(
        eq(schema.productImages.tenantId, schema.shifts.tenantId),
        eq(schema.productImages.productId, schema.shifts.productId),
      ),
    )
    .leftJoin(
      schema.mediaAssets,
      and(
        eq(schema.mediaAssets.id, schema.productImages.assetId),
        eq(schema.mediaAssets.ownerTenantId, tenantId),
        eq(schema.mediaAssets.status, "active"),
      ),
    )
    .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)))
    .limit(1);
  if (!row) throw new NotFoundException();
  if (row.status !== "planned" && row.status !== "active") {
    throw new ConflictException({ code: "SHIFT_TASK_FORM_CLOSED" });
  }
  return {
    shiftId: row.id,
    shiftNumber: formatShiftNumber(row),
    status: row.status,
    mode: row.mode,
    organizationName: row.organizationName,
    productId: row.productId,
    productName: row.productName,
    productPrintName: row.productPrintName,
    gtin14: row.gtin14,
    imageChecksum: row.imageChecksum,
    lineName: row.lineName,
    plannedDate: row.plannedDate,
    productionDate: row.productionDate,
    plannedQty: row.plannedQty,
    boxCapacity: row.boxCapacity,
    palletsEnabled: row.palletsEnabled,
    palletBoxCapacity: row.palletBoxCapacity,
    counterpartyName: row.counterpartyName,
    ssccIssuerName: row.ssccIssuerName,
    validationPrintMode: row.validationPrintMode,
    validationPrintVerification: row.validationPrintVerification,
    allowPreviouslyAcceptedCodes: row.allowPreviouslyAcceptedCodes,
    generatedAt,
  };
}

renderTaskForm(data: ShiftTaskFormData): string {
  return renderShiftTaskFormHtml(data);
}
```

`formatShiftNumber` — уже существующий в этом файле помощник сборки номера из `numberMonthKey`, `numberSeq` и `createdFrom`. Если он назван иначе или не экспортирован из модуля, использовать тот же способ, которым номер собирается в `mapShiftRow`, а не писать вторую реализацию.

- [ ] **Step 4: Добавить маршрут в контроллер**

В `apps/api/src/modules/shifts/shifts.controller.ts` добавить к импортам из `@nestjs/common` — `Res`, к импортам из `@nestjs/swagger` — `ApiProduces`, и `import type { Response } from "express";`.

Вставить маршрут **перед** `@Get(":id")` (иначе `:id` перехватит путь):

```ts
@Get(":id/task-form")
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
@ApiOperation({
  summary: "Render the printable shift task form",
  description: "Responds with a text/html page for printing, not JSON. Closed shifts are refused.",
})
@ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
@ApiProduces("text/html")
@ApiOkResponse({ schema: { type: "string" } })
@ApiHttpErrors(401, 403, 404, 409)
@ApiCabinetAuth()
async taskForm(
  @Req() req: RequestWithTenant,
  @Param("id") id: string,
  @Res({ passthrough: true }) res: Response,
): Promise<string> {
  const data = await this.shiftsService.taskFormData(req.tenantId!, id);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  return this.shiftsService.renderTaskForm(data);
}
```

- [ ] **Step 5: Расширить OpenAPI-тест**

В `apps/api/test/shifts-openapi.test.ts` найти список путей и добавить в него `["/shifts/{id}/task-form", "get"]`, затем добавить проверку формата ответа:

```ts
const taskForm = operation(document, "/shifts/{id}/task-form", "get");
const taskFormResponse = taskForm.responses["200"];
if (!taskFormResponse || "$ref" in taskFormResponse) {
  throw new Error("Missing inline shift task-form response");
}
expect(Object.keys(taskFormResponse.content ?? {})).toEqual(["text/html"]);
expect(taskFormResponse.content?.["text/html"]?.schema).toEqual({ type: "string" });
```

- [ ] **Step 6: Прогнать тесты и убедиться, что они проходят**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/shifts.e2e.test.ts test/shifts-openapi.test.ts
```

Ожидается: PASS. Пропуск из-за отсутствующего `DATABASE_URL` не считается прохождением — о нём надо сообщить отдельно.

- [ ] **Step 7: Коммит**

```bash
git add apps/api/src/modules/shifts/shifts.service.ts apps/api/src/modules/shifts/shifts.controller.ts apps/api/test/shifts.e2e.test.ts apps/api/test/shifts-openapi.test.ts
git commit -m "feat(api): маршрут печатного бланка смены

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Колонка способа входа

**Files:**
- Create: `packages/db/migrations/0167_shift_entry_method.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/platform.ts:506-533`

**Interfaces:**
- Consumes: ничего.
- Produces: `schema.shiftEntryMethod` — `pgEnum("shift_entry_method", ["list", "task_barcode"])`; колонка `shiftDeviceParticipants.entryMethod` типа `"list" | "task_barcode"`, `NOT NULL DEFAULT 'list'`.

- [ ] **Step 1: Написать падающий тест схемы**

Добавить в существующий файл тестов схемы `packages/db` (тот, где проверяются колонки таблиц смен):

```ts
it("records how a device entered a shift, defaulting old rows to the list", () => {
  const column = schema.shiftDeviceParticipants.entryMethod;
  expect(column.notNull).toBe(true);
  expect(column.default).toBe("list");
  expect(schema.shiftEntryMethod.enumValues).toEqual(["list", "task_barcode"]);
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/db exec vitest run -t "how a device entered a shift"
```

Ожидается: FAIL, `entryMethod` не существует.

- [ ] **Step 3: Описать колонку в схеме**

В `packages/db/src/schema/platform.ts` рядом с другими `pgEnum` смен (около строки 31) добавить:

```ts
export const shiftEntryMethod = pgEnum("shift_entry_method", ["list", "task_barcode"]);
```

В `shiftDeviceParticipants` после `lastEnteredAt` добавить:

```ts
    /**
     * How this device last got into the shift. `task_barcode` means the printed
     * task form was scanned; the barcode grants nothing extra, so this answers
     * "was the shop floor working from paper", not "was it allowed in".
     */
    entryMethod: shiftEntryMethod("entry_method").notNull().default("list"),
```

- [ ] **Step 4: Создать миграцию**

Создать `packages/db/migrations/0167_shift_entry_method.sql`:

```sql
CREATE TYPE "public"."shift_entry_method" AS ENUM('list', 'task_barcode');--> statement-breakpoint
ALTER TABLE "shift_device_participants" ADD COLUMN "entry_method" "shift_entry_method" DEFAULT 'list' NOT NULL;
```

В `packages/db/migrations/meta/_journal.json` добавить последним элементом массива:

```json
    {
      "idx": 167,
      "version": "7",
      "when": 1789900000000,
      "tag": "0167_shift_entry_method",
      "breakpoints": true
    }
```

Значение `when` должно быть больше, чем у записи `0166` (`1789837824173`).

- [ ] **Step 5: Применить миграцию и прогнать тесты пакета**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db db:migrate && pnpm --filter @markiro/db test && pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint && pnpm --filter @markiro/db build
```

Ожидается: миграция применяется, все гейты зелёные.

- [ ] **Step 6: Коммит**

```bash
git add packages/db/src/schema/platform.ts packages/db/migrations/0167_shift_entry_method.sql packages/db/migrations/meta/_journal.json packages/db/test
git commit -m "feat(db): способ входа устройства в смену

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: `entryMethod` на обоих маршрутах входа

**Files:**
- Modify: `apps/api/src/modules/shifts/dto.ts`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts:452-500`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts` (`openShift`, `enterShift`)
- Modify: `apps/api/test/shifts.e2e.test.ts`

**Interfaces:**
- Consumes: `schema.shiftDeviceParticipants.entryMethod` (Task 5).
- Produces: `shiftEntrySchema` — `z.strictObject({ entryMethod: z.enum(["list", "task_barcode"]).default("list") })`; `type ShiftEntryDto`. `openShift` и `enterShift` принимают дополнительный аргумент `entryMethod: "list" | "task_barcode"`.

- [ ] **Step 1: Написать падающий e2e-тест**

Добавить в `apps/api/test/shifts.e2e.test.ts`:

```ts
it("records the entry method on both entry routes and defaults a bodiless request to the list", async () => {
  const scanned = await createPlannedShift();
  await station.post(`/shifts/${scanned.id}/open`).send({ entryMethod: "task_barcode" }).expect(200);

  const picked = await createPlannedShift();
  await station.post(`/shifts/${picked.id}/open`).expect(200);

  const handheld = await createPlannedShift();
  await handheldStation
    .post(`/shifts/${handheld.id}/enter`)
    .send({ entryMethod: "task_barcode" })
    .expect(200);

  const rows = await db
    .select({
      shiftId: schema.shiftDeviceParticipants.shiftId,
      entryMethod: schema.shiftDeviceParticipants.entryMethod,
    })
    .from(schema.shiftDeviceParticipants)
    .where(eq(schema.shiftDeviceParticipants.tenantId, tenantId));
  const byShift = new Map(rows.map((row) => [row.shiftId, row.entryMethod]));

  expect(byShift.get(scanned.id)).toBe("task_barcode");
  expect(byShift.get(picked.id)).toBe("list");
  expect(byShift.get(handheld.id)).toBe("task_barcode");
});

it("refuses an unknown entry method instead of silently recording the default", async () => {
  const shift = await createPlannedShift();
  await station.post(`/shifts/${shift.id}/open`).send({ entryMethod: "telepathy" }).expect(400);
});

it("overwrites the entry method when the same device comes back a different way", async () => {
  const shift = await createPlannedShift();
  await station.post(`/shifts/${shift.id}/open`).send({ entryMethod: "task_barcode" }).expect(200);
  await station.post(`/shifts/${shift.id}/enter`).send({ entryMethod: "list" }).expect(200);

  const [row] = await db
    .select({ entryMethod: schema.shiftDeviceParticipants.entryMethod })
    .from(schema.shiftDeviceParticipants)
    .where(
      and(
        eq(schema.shiftDeviceParticipants.tenantId, tenantId),
        eq(schema.shiftDeviceParticipants.shiftId, shift.id),
      ),
    );
  expect(row?.entryMethod).toBe("list");
});
```

`handheldStation` — клиент устройства с `kind: "handheld"`; если такого помощника в файле нет, создать его тем же способом, что соседние тесты создают станционного клиента, передав вид устройства `handheld`.

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/shifts.e2e.test.ts -t "entry method"
```

Ожидается: FAIL — колонка заполняется `list` во всех трёх случаях, а неизвестное значение принимается.

- [ ] **Step 3: Описать DTO**

В `apps/api/src/modules/shifts/dto.ts` добавить:

```ts
export const SHIFT_ENTRY_METHODS = ["list", "task_barcode"] as const;
export type ShiftEntryMethod = (typeof SHIFT_ENTRY_METHODS)[number];

/**
 * How the device says it got in. Absent body means `list`, which is what every
 * terminal built before the printed task form sends.
 */
export const shiftEntrySchema = z.strictObject({
  entryMethod: z.enum(SHIFT_ENTRY_METHODS).default("list"),
});
export type ShiftEntryDto = z.infer<typeof shiftEntrySchema>;
```

- [ ] **Step 4: Принять тело в контроллере**

В `apps/api/src/modules/shifts/shifts.controller.ts` в обработчике `@Post(":id/open")` добавить параметр и прокинуть значение:

```ts
async openShift(
  @Req() req: RequestWithTenant,
  @Param("id") id: string,
  @Body(new ZodValidationPipe(shiftEntrySchema)) body: ShiftEntryDto,
) {
  const result = await this.shiftsService.openShift(
    req.tenantId!,
    id,
    req.authKind === "station"
      ? { domain: "station_device", id: req.deviceId! }
      : { domain: "cabinet", id: req.userId! },
    req.deviceId,
    req.get("x-station-capabilities"),
    body.entryMethod,
  );
  …
}
```

Добавить к декораторам маршрута `@ApiZodBody(shiftEntrySchema)`. То же самое сделать для `@Post(":id/enter")`, передав `body.entryMethod` последним аргументом `enterShift`.

Пустое тело обязано давать `entryMethod: "list"` — это обеспечивает `.default("list")` в схеме. Проверить, что `ZodValidationPipe` получает `{}`, а не `undefined`, при запросе без тела; если пайп отвергает `undefined`, дать схеме `.default({})` на верхнем уровне через `shiftEntrySchema.default({ entryMethod: "list" })`.

- [ ] **Step 5: Записать значение в сервисе**

В `apps/api/src/modules/shifts/shifts.service.ts` добавить параметр `entryMethod: ShiftEntryMethod = "list"` в сигнатуры `openShift` и `enterShift`, прокинуть его из `openShift` в `enterShift` при делегировании (`if (deviceId) return this.enterShift(tenantId, id, deviceId, capabilities, entryMethod);`) и подставить в запись участия:

```ts
await tx
  .insert(schema.shiftDeviceParticipants)
  .values({ tenantId, shiftId: id, deviceId, firstEnteredAt: now, lastEnteredAt: now, entryMethod })
  .onConflictDoUpdate({
    target: [
      schema.shiftDeviceParticipants.tenantId,
      schema.shiftDeviceParticipants.shiftId,
      schema.shiftDeviceParticipants.deviceId,
    ],
    set: { lastEnteredAt: now, entryMethod },
  });
```

- [ ] **Step 6: Прогнать тесты и убедиться, что они проходят**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/shifts.e2e.test.ts test/shifts.service.test.ts test/shifts.controller.test.ts test/shifts-openapi.test.ts
```

Ожидается: PASS.

- [ ] **Step 7: Коммит**

```bash
git add apps/api/src/modules/shifts/dto.ts apps/api/src/modules/shifts/shifts.controller.ts apps/api/src/modules/shifts/shifts.service.ts apps/api/test/shifts.e2e.test.ts
git commit -m "feat(api): принимать способ входа на обоих маршрутах входа в смену

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Кнопка бланка в админке

**Files:**
- Modify: `apps/admin/src/pages/shifts/ShiftDetailsPanel.tsx:553-570`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/shift-task-form.test.tsx`

**Interfaces:**
- Consumes: маршрут `GET /shifts/:id/task-form` (Task 4).
- Produces: ничего для последующих задач.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/admin/test/shift-task-form.test.tsx` по образцу `apps/admin/test/inventory-task-form.test.tsx`: отрендерить `ShiftDetailsPanel` с плановой сменой, правами только на чтение (`CABINET_CAPABILITY.OPERATIONS_READ`) и проверить:

```tsx
it("opens the printable shift task form in a new tab for a read-only administrator", async () => {
  const openMock = vi.fn();
  vi.stubGlobal("open", openMock);
  const user = renderPanel({ status: "planned" });

  const action = await screen.findByRole("button", { name: "Открыть бланк смены" });
  expect(action.hasAttribute("disabled")).toBe(false);

  await user.click(action);
  expect(openMock).toHaveBeenCalledWith(
    `/api/shifts/${SHIFT_ID}/task-form`,
    "_blank",
    "noopener,noreferrer",
  );
});

it("offers the form for an active shift too, because one sheet lives the whole shift", async () => {
  renderPanel({ status: "active" });
  expect(await screen.findByRole("button", { name: "Открыть бланк смены" })).toBeDefined();
});

it("hides the form for a closed shift, whose barcode no terminal would accept", async () => {
  renderPanel({ status: "closed" });
  expect(screen.queryByRole("button", { name: "Открыть бланк смены" })).toBeNull();
});

it("localizes the action in English", async () => {
  await i18n.changeLanguage("en");
  renderPanel({ status: "planned" });
  expect(await screen.findByRole("button", { name: "Open shift form" })).toBeDefined();
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/admin exec vitest run test/shift-task-form.test.tsx
```

Ожидается: FAIL, кнопка не найдена.

- [ ] **Step 3: Добавить строки локализации**

В `apps/admin/src/i18n/ru.json` в объект `pages.shifts.details` добавить:

```json
"taskFormTitle": "Бланк смены",
"taskFormDescription": "Печатная A4-форма со штрихкодом для открытия смены на терминале.",
"openTaskForm": "Открыть бланк смены"
```

В `apps/admin/src/i18n/en.json` в тот же объект:

```json
"taskFormTitle": "Shift form",
"taskFormDescription": "A printable A4 sheet whose barcode opens the shift on a terminal.",
"openTaskForm": "Open shift form"
```

- [ ] **Step 4: Добавить секцию в панель**

В `apps/admin/src/pages/shifts/ShiftDetailsPanel.tsx` перед секцией `pages.shifts.exports.title` вставить:

```tsx
{shift.status !== "closed" ? (
  <section className="mk-shift-details__section">
    <h3>{t("pages.shifts.details.taskFormTitle")}</h3>
    <p className="mk-shift-details__reports-hint">
      {t("pages.shifts.details.taskFormDescription")}
    </p>
    <Button
      type="button"
      variant="secondary"
      onClick={() =>
        window.open(`/api/shifts/${shift.id}/task-form`, "_blank", "noopener,noreferrer")
      }
    >
      {t("pages.shifts.details.openTaskForm")}
    </Button>
  </section>
) : null}
```

Секция сознательно не закрыта проверкой `canWrite`: напечатать наряд — операция чтения, и администратор со правом только на чтение должен её выполнять.

- [ ] **Step 5: Прогнать тест и гейты пакета**

```bash
pnpm --filter @markiro/admin exec vitest run test/shift-task-form.test.tsx && pnpm --filter @markiro/admin test && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint && pnpm --filter @markiro/admin build
```

Ожидается: PASS и зелёные гейты.

- [ ] **Step 6: Коммит**

```bash
git add apps/admin/src/pages/shifts/ShiftDetailsPanel.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/shift-task-form.test.tsx
git commit -m "feat(admin): печать бланка смены из карточки смены

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Сканирование бланка на станции

**Files:**
- Modify: `apps/station/src/pages/ShiftSelection.tsx`
- Modify: `apps/station/src/pages/TaskSelection.tsx:497-543`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/src/station.css:1020-1075`
- Test: `apps/station/test/shift-selection-barcode.test.tsx`

**Interfaces:**
- Consumes: `parseShiftTaskBarcode`, `SHIFT_TASK_BARCODE_PREFIX` из `@markiro/domain` (Task 1); тело `entryMethod` у `POST /shifts/:id/open` (Task 6).
- Produces: `ShiftSelectionProps.source?: ScanSource`.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/station/test/shift-selection-barcode.test.tsx` по образцу `apps/station/test/shift-selection.test.tsx`, добавив помощник `scanner()` из `apps/station/test/inventory-task-selection.test.tsx`:

```tsx
it("opens the scanned planned shift and tells the server the paper was used", async () => {
  const scan = scanner();
  const post = vi.fn().mockResolvedValue({ id: SHIFT_ID, status: "active", mode: "aggregation" });
  const onSelected = vi.fn();
  renderSelection({ scan, post, onSelected, items: [plannedShift()] });

  await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());
  act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}`));

  await waitFor(() => expect(onSelected).toHaveBeenCalled());
  expect(post).toHaveBeenCalledWith(`/shifts/${SHIFT_ID}/open`, { entryMethod: "task_barcode" });
});

it("enters a scanned active shift without asking the server to open it again", async () => {
  const scan = scanner();
  const post = vi.fn();
  const onSelected = vi.fn();
  renderSelection({ scan, post, onSelected, items: [activeShift()] });

  await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());
  act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}`));

  await waitFor(() => expect(onSelected).toHaveBeenCalled());
  expect(post).not.toHaveBeenCalled();
});

it("says the shift is closed rather than pretending the barcode is unreadable", async () => {
  const scan = scanner();
  renderSelection({ scan, items: [closedShift()] });

  await waitFor(() => expect(screen.getByText("No open shifts")).toBeDefined());
  act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}`));

  expect(await screen.findByText("This shift is closed.")).toBeDefined();
});

it("says the shift belongs to another line when it is not in this terminal's list", async () => {
  const scan = scanner();
  renderSelection({ scan, items: [] });

  act(() => scan.scan("markiro:shift:v1:44444444-4444-4444-8444-444444444444"));

  expect(await screen.findByText("This shift is not on this line.")).toBeDefined();
});

it("reports an unreadable barcode for a well-prefixed payload that is not a shift id", async () => {
  const scan = scanner();
  renderSelection({ scan, items: [plannedShift()] });

  act(() => scan.scan("markiro:shift:v1:not-a-uuid"));

  expect(await screen.findByText("The shift form barcode could not be read.")).toBeDefined();
});

it("ignores a production code so a unit scan never navigates the terminal", async () => {
  const scan = scanner();
  const onSelected = vi.fn();
  renderSelection({ scan, onSelected, items: [plannedShift()] });

  await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());
  act(() => scan.scan("010468008990038321ABC93XYZ"));

  expect(onSelected).not.toHaveBeenCalled();
  expect(screen.queryByText("The shift form barcode could not be read.")).toBeNull();
});
```

`renderSelection` подставляет `source={scan.source}`, мокает `fetch` списком `items` и подменяет `client.post` на переданный `post`.

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/station exec vitest run test/shift-selection-barcode.test.tsx
```

Ожидается: FAIL — у `ShiftSelection` нет свойства `source`.

- [ ] **Step 3: Добавить строки локализации**

В `apps/station/src/i18n/ru.json` в объект `shifts`:

```json
"scanTitle": "Отсканируйте штрихкод бланка смены",
"scanHint": "Смена откроется автоматически. Бланк смены другой линии на этом терминале не сработает.",
"taskBarcode": "ШТРИХКОД БЛАНКА",
"barcodeFailed": "Не удалось распознать штрихкод бланка смены.",
"barcodeClosed": "Эта смена закрыта.",
"barcodeNotOnLine": "Этой смены нет на этой линии."
```

В `apps/station/src/i18n/en.json` в тот же объект:

```json
"scanTitle": "Scan the shift form barcode",
"scanHint": "The shift opens automatically. A form for another line will not work on this terminal.",
"taskBarcode": "FORM BARCODE",
"barcodeFailed": "The shift form barcode could not be read.",
"barcodeClosed": "This shift is closed.",
"barcodeNotOnLine": "This shift is not on this line."
```

- [ ] **Step 4: Добавить зону сканирования и разбор в `ShiftSelection`**

Добавить импорты:

```ts
import { parseShiftTaskBarcode, SHIFT_TASK_BARCODE_PREFIX } from "@markiro/domain";
import type { ScanSource } from "../lib/scan-source.js";
```

В `ShiftSelectionProps` добавить:

```ts
  /** Scanner feed; omitted where the screen has no scanner (tests, gallery). */
  source?: ScanSource;
```

Подписку разместить рядом с прочими эффектами компонента. Она обязана: срабатывать только пока производственная категория активна (`alternateActive !== true`), брать только штрихкоды бланка смены, а всё остальное молча отдавать другим потребителям скана:

```ts
useEffect(() => {
  if (!source || alternateActive) return;
  return source.start((raw) => {
    // Every other scan on this screen belongs to somebody else -- a unit code,
    // an inventory form. Staying silent on them is the difference between a
    // shared scanner and one that argues with its neighbours.
    if (!raw.startsWith(SHIFT_TASK_BARCODE_PREFIX)) return;
    const shiftId = parseShiftTaskBarcode(raw);
    if (shiftId === null) {
      setError(t("shifts.barcodeFailed"));
      return;
    }
    if (controlsDisabled) return;
    // `items`, not `openItems`: the closed shift is in the list, and naming it
    // beats sending an operator to look for a shift that already ended.
    const match = items.find((shift) => shift.id === shiftId);
    if (!match) {
      setError(t("shifts.barcodeNotOnLine"));
      return;
    }
    if (match.status === "closed" || match.status === "closing") {
      setError(t("shifts.barcodeClosed"));
      return;
    }
    setError(null);
    void (match.status === "active" ? rejoin(match) : open(match));
  });
}, [alternateActive, controlsDisabled, items, open, rejoin, source, t]);
```

Если `open` и `rejoin` объявлены как обычные функции внутри компонента, обернуть их в `useCallback` или вызвать через `useRef`-держатель — правила хуков должны соблюдаться без отключения линтера.

Зону сканирования отрисовать первым элементом внутри `shift-selection__slot`, только когда `source` передан и `alternateActive !== true`:

```tsx
{source && !alternateActive ? (
  <section className="shift-selection__scan" aria-labelledby="shift-scan-title">
    <span className="shift-selection__scan-mark" aria-hidden="true" />
    <div>
      <h2 id="shift-scan-title">{t("shifts.scanTitle")}</h2>
      <p>{t("shifts.scanHint")}</p>
    </div>
    <strong>{t("shifts.taskBarcode")}</strong>
  </section>
) : null}
```

- [ ] **Step 5: Переиспользовать стили зоны сканирования**

В `apps/station/src/station.css` в каждое правило блока `.inventory-task-selection__scan*` (строки 1020-1075: сам блок, `__scan-mark`, оба псевдоэлемента, заголовки) добавить парный селектор `.shift-selection__scan…`. Например:

```css
.inventory-task-selection__scan,
.shift-selection__scan {
```

Новых значений не вводить: две зоны сканирования на соседних экранах одного терминала обязаны выглядеть одинаково.

- [ ] **Step 6: Прокинуть источник и способ входа**

В `apps/station/src/pages/TaskSelection.tsx` передать `source` в `ShiftSelection` (`source={source}`) и в существующем обработчике скана первым действием отфильтровать чужой префикс:

```ts
return source.start((barcode) => {
  // The shift panel owns this namespace and subscribes to the same source.
  if (barcode.startsWith(SHIFT_TASK_BARCODE_PREFIX)) return;
  if (!intakeOpen.current || busyRef.current || isCurrentRef.current?.() === false) return;
  …
});
```

добавив импорт `SHIFT_TASK_BARCODE_PREFIX` из `@markiro/domain`.

В `ShiftSelection.open` передать способ входа — он приходит из того, чем оператор воспользовался:

```ts
async function open(shift: ShiftListItem, entryMethod: "list" | "task_barcode" = "list"): Promise<void> {
  await enterShift(shift, () =>
    client.post<{ id: string; status: string; mode: string }>(`/shifts/${shift.id}/open`, {
      entryMethod,
    }),
  );
}
```

и вызывать `open(match, "task_barcode")` из обработчика скана, оставив нажатие карточки как `open(shift)`.

- [ ] **Step 7: Прогнать тесты и гейты пакета**

```bash
pnpm turbo run build --filter='@markiro/station^...'
pnpm --filter @markiro/station exec vitest run test/shift-selection-barcode.test.tsx test/shift-selection.test.tsx test/inventory-task-selection.test.tsx
pnpm --filter @markiro/station test && pnpm --filter @markiro/station typecheck && pnpm --filter @markiro/station lint && pnpm --filter @markiro/station build
```

Ожидается: PASS и зелёные гейты. Особое внимание — `inventory-task-selection.test.tsx`: он доказывает, что фильтр префикса не сломал разбор штрихкодов инвентаризации.

- [ ] **Step 8: Коммит**

```bash
git add apps/station/src/pages/ShiftSelection.tsx apps/station/src/pages/TaskSelection.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/src/station.css apps/station/test/shift-selection-barcode.test.tsx
git commit -m "feat(station): открывать смену сканированием бланка

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Разбор токена на ТСД

**Files:**
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/barcode/ShiftTaskToken.kt`
- Create: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/barcode/ShiftTaskTokenTest.kt`

**Interfaces:**
- Consumes: правило формата из Task 1 (повторяется, а не импортируется — это другой язык).
- Produces: `object ShiftTaskToken` с `const val PREFIX: String` и `fun parse(raw: String): String?`.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/barcode/ShiftTaskTokenTest.kt`:

```kotlin
package app.markiro.handheld.core.barcode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShiftTaskTokenTest {
    private val shiftId = "11111111-1111-4111-8111-111111111111"

    @Test
    fun `parses the frozen v1 namespace`() {
        assertEquals("markiro:shift:v1:", ShiftTaskToken.PREFIX)
        assertEquals(shiftId, ShiftTaskToken.parse("markiro:shift:v1:$shiftId"))
    }

    @Test
    fun `lowercases the id so one shift keeps one identity`() {
        assertEquals(shiftId, ShiftTaskToken.parse("markiro:shift:v1:${shiftId.uppercase()}"))
    }

    @Test
    fun `refuses the inventory namespace`() {
        assertNull(ShiftTaskToken.parse("markiro:inventory:v1:$shiftId"))
    }

    @Test
    fun `refuses a well-prefixed payload that is not a uuid`() {
        assertNull(ShiftTaskToken.parse("markiro:shift:v1:not-a-uuid"))
        assertNull(ShiftTaskToken.parse("markiro:shift:v1:"))
    }

    @Test
    fun `refuses a bare uuid and a production code`() {
        assertNull(ShiftTaskToken.parse(shiftId))
        assertNull(ShiftTaskToken.parse("010468008990038321ABC93XYZ"))
    }
}
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ShiftTaskTokenTest*'
```

Ожидается: FAIL компиляции, `Unresolved reference: ShiftTaskToken`.

- [ ] **Step 3: Написать реализацию**

Создать `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/barcode/ShiftTaskToken.kt`:

```kotlin
package app.markiro.handheld.core.barcode

/**
 * The printed shift task form's Data Matrix payload.
 *
 * Deliberately a second implementation of the rule in `@markiro/domain`
 * (`src/barcodes/task-tokens.ts`) rather than a shared artefact: Kotlin cannot
 * import it, and a generated fixture would be heavier than the rule itself.
 * `ShiftTaskTokenTest` mirrors the TypeScript cases one for one -- change both
 * or neither.
 */
object ShiftTaskToken {
    const val PREFIX = "markiro:shift:v1:"

    private val UUID = Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )

    /** The shift id this scan carries, or null when the scan is not a shift form. */
    fun parse(raw: String): String? {
        if (!raw.startsWith(PREFIX)) return null
        val id = raw.substring(PREFIX.length).lowercase()
        return if (UUID.matches(id)) id else null
    }
}
```

- [ ] **Step 4: Прогнать тест и убедиться, что он проходит**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ShiftTaskTokenTest*'
```

Ожидается: PASS, 5 тестов.

- [ ] **Step 5: Коммит**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/barcode/ShiftTaskToken.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/barcode/ShiftTaskTokenTest.kt
git commit -m "feat(handheld): разбор токена бланка смены

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Сканирование бланка на ТСД

**Files:**
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/StationApi.kt:58-59`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/Dtos.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftRepository.kt:139-192`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftListViewModel.kt`
- Modify: `apps/handheld/app/src/main/res/values/strings.xml`
- Modify: `apps/handheld/app/src/main/res/values-en/strings.xml`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftListScanTest.kt`

**Interfaces:**
- Consumes: `ShiftTaskToken` (Task 9); тело `entryMethod` у `POST /shifts/:id/enter` (Task 6).
- Produces: ничего для последующих задач.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftListScanTest.kt` по образцу `ShiftListViewModelTest.kt`, подавая сканы через `ScanRouterAdapter(flowOf(...))` или `MutableSharedFlow`. Покрыть:

```kotlin
package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShiftListScanTest {
    private val shiftId = "11111111-1111-4111-8111-111111111111"
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 8)

    private fun scan(raw: String) = scans.tryEmit(ScanEvent(raw = raw, at = 0L))

    @Test
    fun `scanned shift of this line is entered with the barcode entry method`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, lineId = OWN_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))

        scan("markiro:shift:v1:$shiftId")
        advanceUntilIdle()

        assertEquals(shiftId, api.enteredShiftId)
        assertEquals("task_barcode", api.lastEnterBody?.entryMethod)
    }

    @Test
    fun `scanned shift of another line asks for confirmation instead of entering`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, lineId = OTHER_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))

        scan("markiro:shift:v1:$shiftId")
        advanceUntilIdle()

        assertTrue(model.ui.value.dialog is ShiftDialog.ConfirmOther)
        assertNull(api.enteredShiftId)
    }

    @Test
    fun `scanned closed shift shows the closed dialog`() = runTest {
        val api = FakeStationApi(shifts = listOf(closedShift(shiftId)))
        val model = viewModel(api, ScanRouterAdapter(scans))

        scan("markiro:shift:v1:$shiftId")
        advanceUntilIdle()

        assertEquals(ShiftDialog.Closed, model.ui.value.dialog)
    }

    @Test
    fun `scan of a shift missing from the list shows the unknown-barcode dialog`() = runTest {
        val api = FakeStationApi(shifts = emptyList())
        val model = viewModel(api, ScanRouterAdapter(scans))

        scan("markiro:shift:v1:$shiftId")
        advanceUntilIdle()

        assertEquals(ShiftDialog.BarcodeUnknown, model.ui.value.dialog)
    }

    @Test
    fun `scan is ignored while a dialog is open`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, lineId = OWN_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))
        model.showClosedDialogForTest()

        scan("markiro:shift:v1:$shiftId")
        advanceUntilIdle()

        assertNull(api.enteredShiftId)
    }

    @Test
    fun `production code scan is ignored and opens no dialog`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, lineId = OWN_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))

        scan("010468008990038321ABC93XYZ")
        advanceUntilIdle()

        assertNull(api.enteredShiftId)
        assertNull(model.ui.value.dialog)
    }
}
```

`FakeStationApi`, `plannedShift`, `closedShift` и `viewModel` строить теми же помощниками, что уже использует `ShiftListViewModelTest.kt` и `ShiftEntityFixtures.kt`; вторую реализацию фикстур не заводить. `showClosedDialogForTest` заменить на тот способ, которым существующие тесты приводят модель в состояние с открытым диалогом.

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*ShiftListScanTest*'
```

Ожидается: FAIL компиляции — `ShiftListViewModel` не принимает `ScanEvents`.

- [ ] **Step 3: Добавить строки**

В `apps/handheld/app/src/main/res/values/strings.xml`:

```xml
<string name="shifts_barcode_unknown_title">Смена не найдена</string>
<string name="shifts_barcode_unknown_text">Штрихкод бланка не совпал ни с одной сменой в списке. Обновите список или выберите смену вручную.</string>
```

В `apps/handheld/app/src/main/res/values-en/strings.xml`:

```xml
<string name="shifts_barcode_unknown_title">Shift not found</string>
<string name="shifts_barcode_unknown_text">The form barcode matched no shift in the list. Refresh the list or pick the shift by hand.</string>
```

- [ ] **Step 4: Передать способ входа в сеть**

В `apps/handheld/.../core/network/Dtos.kt` добавить:

```kotlin
@Serializable
data class ShiftEntryRequest(val entryMethod: String)
```

В `apps/handheld/.../core/network/StationApi.kt` заменить объявление `enter`:

```kotlin
@POST("shifts/{id}/enter")
suspend fun enter(@Path("id") id: String, @Body body: ShiftEntryRequest): ShiftDto
```

В `ShiftRepository` добавить параметр способа входа и прокинуть его:

```kotlin
suspend fun enter(shiftId: String, entryMethod: String = "list"): EnterResult =
    db.recovery.work { enterOwned(shiftId, entryMethod) }

private suspend fun enterOwned(shiftId: String, entryMethod: String): EnterResult {
    …
    val entered = try {
        api.enter(shiftId, ShiftEntryRequest(entryMethod))
    } …
}
```

- [ ] **Step 5: Подписать список смен на сканер**

В `ShiftListViewModel` добавить параметр конструктора `scans: ScanEvents` и подписку в `init`, тем же приёмом, что `InventoryListViewModel`:

```kotlin
init {
    launchOwned { scans.events.collect { event -> onScan(event.raw) } }
    …
}

/**
 * The form barcode is a shortcut to the card, not a key: a shift of another
 * line still goes through the same confirmation the list shows.
 */
private suspend fun onScan(raw: String) {
    if (dialog.value != null) return
    val shiftId = ShiftTaskToken.parse(raw.trim()) ?: return
    val match = repository.listed(shiftId)
    if (match == null) {
        dialog.value = ShiftDialog.BarcodeUnknown
        return
    }
    if (match.status == "closed") {
        dialog.value = ShiftDialog.Closed
        return
    }
    val ownLine = ownLineId()
    if (match.lineId != null && match.lineId != ownLine) {
        dialog.value = ShiftDialog.ConfirmOther(match, lineNameOf(match.lineId))
        return
    }
    enter(match, entryMethod = "task_barcode")
}
```

Добавить в `sealed interface ShiftDialog` вариант `data object BarcodeUnknown : ShiftDialog` и отрисовать его в `ShiftDialogScreen` парой строк из шага 3.

`repository.listed(shiftId)` — поиск по уже загруженному списку (свои смены плюс раскрытые чужие линии); если такого метода нет, добавить его в `ShiftRepository` как чтение из той же памяти/кеша, из которой строится `ShiftListUi`, без нового сетевого запроса.

Существующий путь подтверждения чужой линии (`ShiftDialog.ConfirmOther`) обязан входить с тем же `entryMethod = "task_barcode"`, если диалог открыло сканирование, и с `"list"`, если выбор из списка.

- [ ] **Step 6: Прогнать тесты и гейты**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

Ожидается: PASS и успешная сборка debug-APK. Прогон на эмуляторе не доказывает работу вендорского сканера — это отмечается в отчёте отдельно.

- [ ] **Step 7: Коммит**

```bash
git add apps/handheld
git commit -m "feat(handheld): открывать смену сканированием бланка

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Финальная проверка

- [ ] **Step 1: Широкие гейты монорепозитория**

```bash
set -a; source .env; set +a
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
git diff --check
```

Ожидается: всё зелёное. Пропуски из-за отсутствующей инфраструктуры перечислить явно.

- [ ] **Step 2: Гейты ТСД**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

- [ ] **Step 3: Внешняя проверка, которую автотесты не закрывают**

Зафиксировать в итоговом отчёте как непроверенное, если стенд недоступен:

- печать бланка на бумаге, читаемость DataMatrix 32 мм реальным сканером;
- загрузка фото продукции в печатной вкладке и её попадание на бумагу;
- поведение вендорского сканера ТСД на экране списка смен;
- сканирование бланка на живом станционном терминале.
