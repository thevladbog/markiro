# MKR-INS-09 «Смена: наблюдение, закрытие и отчёты» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Опубликовать девятую печатную инструкцию — что менеджер делает, пока смена идёт и после: наблюдение по дашборду, закрытие из кабинета, данные после закрытия, отчёты для ГИС МТ и их отказы.

**Architecture:** Конвейер серии без изменений: кадры реальными страницами кабинета под строгим перехватом `/api/` (расширение production-сьюты), контент модулем в `@markiro/legal-documents`, лендинг общим компонентом, PDF/A-2b в манифест и доверенную аттестацию.

**Tech Stack:** pnpm + turbo; React 19 (кабинет); Playwright; `docx` 9.7.1 → LibreOffice 26.2.5 → veraPDF 1.30.2; Astro; node:test (аттестация).

## Global Constraints

- Код `MKR-INS-09`, kind `instruction`, ревизия `2026.09/01`, effectiveDate `2026-09-02`, статус `active`, RU-only, маршрут `/instruktsii/smena-zakrytie/`.
- Аудитория — менеджер кабинета; роль в моках `manager` → `["operations.read", "operations.write"]`.
- Каждая цитата в кавычках-ёлочках существует ДОСЛОВНО в `apps/admin/src/i18n/ru.json` (ветки `pages.shifts`, `pages.dashboard`) И видима на кадре своего шага; реальная строка с другого экрана/состояния подаётся прозой с указанием, где она.
- Ни один кадр не показывает состояние, которого API не может вернуть. Вердикт дашборда и его причины — производные от данных того же мокнутого ответа: `needs_attention` без соответствующего `reasons[]` — фабрикация. Ответ `/dashboard/overview` парсится zod-схемой `.strict()` (`apps/admin/src/pages/dashboard/api.ts:71-118`) — лишнее или недостающее поле роняет страницу, поэтому фикстура собирается строго по схеме.
- Номера смен — в формате кода: `AUG26-NNN`/`SEP26-NNN` (`apps/admin/src/pages/shifts/api.ts:24`).
- Перехват `/api/` строгий: неучтённый эндпоинт попадает в `unexpected` и роняет тест.
- Pinned-счётчики (измерены на main `5ce4974df`): маршруты 16 → 17; артефакты 20 → 21; PDF 16 → 17; `/legal/` PDF 12 → 13 и SHA 14 → 15; sitemap 64 → 66 в ДВУХ местах; edge-contract (`:950`) 20 → 21; аттестация 16 → 17.
- Release id аттестации: `MKR-LEGAL-2026.08-14-2026-09-02` (следующий номер серии после `-13-`).
- Пиненные тесты не ослабляются; кабинетное закрытие смены подаётся как вспомогательный путь (основной — станция, MKR-INS-02).

---

## File Structure

- `tools/production-browser/tests/production.visual.spec.ts` — расширяется сценариями 09 (дашборд, закрытие, отчёты); тот же конфиг/порт 61594, тот же `cabinet-harness`.
- `packages/legal-documents/src/documents/cabinet-shift-close.ts` — контент.
- Реестр/CLI/лендинг/аттестация — по одному точечному изменению в существующих файлах, как во всех документах серии.

---

### Task 1: Девять кадров через production-сьюту

**Files:**
- Modify: `tools/production-browser/tests/production.visual.spec.ts`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-09/*.png` (9 файлов)

**Interfaces:**
- Consumes: харнесс `apps/admin/test/browser/production.html` (`?route=`), маршруты `/` (дашборд — индексный маршрут шелла; проверить в `apps/admin/src/app.tsx`) и `/shifts`.
- Produces: девять PNG с идентификаторами `dashboard-under-control`, `dashboard-attention`, `shifts-active`, `shift-close`, `shifts-late-badge`, `exports-catalog`, `exports-history`, `exports-failed`, `exports-stale`. Ровно эти идентификаторы используют Task 2 и Task 3.

- [ ] **Step 1: Фикстуры дашборда**

Добавить в спеку после существующих фикстур 08. Ответ `/api/dashboard/overview` обязан проходить `dashboardOverviewSchema` (`.strict()`); windows/buckets заполняются честной арифметикой. Два состояния:

```ts
const DASHBOARD_WINDOW = (start: string, end: string, accepted: number, boxes: number, units: number) => ({
  start,
  end,
  validation: { acceptedUnits: accepted, shiftHours: 8, unitsPerShiftHour: accepted / 8 },
  aggregation: {
    closedBoxes: boxes,
    containedUnits: units,
    shiftHours: 8,
    boxesPerShiftHour: boxes / 8,
    containedUnitsPerShiftHour: units / 8,
  },
});

/**
 * «Производство под контролем»: причин нет, данные полные, одна активная
 * смена. Verdict/quality ДОЛЖНЫ сходиться с данными: нет late_data и
 * конфликтов -> status under_control; активная смена есть -> quality
 * provisional с reason active_shifts (см. spec-риск «вердикт производен
 * от данных кадра»).
 */
const DASHBOARD_UNDER_CONTROL = {
  generatedAt: "2026-09-02T05:30:00.000Z",
  timeZone: "Europe/Moscow",
  metricVersion: "operations-dashboard-v1",
  setup: { productCount: 3, shiftCount: 12, hasRunShift: true },
  verdict: { status: "under_control", reasons: [] },
  today: {
    validationAcceptedUnits: 1180,
    aggregationClosedBoxes: 74,
    aggregationContainedUnits: 888,
    activeShiftCount: 1,
    includedClosedShiftCount: 1,
  },
  dynamics: {
    period: "today",
    grain: "hour",
    currentWindow: DASHBOARD_WINDOW("2026-09-02T00:00:00.000Z", "2026-09-02T08:00:00.000Z", 1180, 74, 888),
    comparisonWindow: DASHBOARD_WINDOW("2026-09-01T00:00:00.000Z", "2026-09-01T08:00:00.000Z", 1050, 66, 792),
    buckets: [],
    quality: {
      status: "provisional",
      reasons: ["active_shifts"],
      activeShiftCount: 1,
      lateDataShiftCount: 0,
      sources: ["code_registry", "boxes", "box_items"],
    },
  },
  activeShifts: [
    {
      id: ACTIVE_SHIFT_ID,
      number: "SEP26-004",
      productName: PRODUCT.name,
      lineName: LINE.name,
      openedAt: "2026-09-02T04:10:00.000Z",
      lateDataAt: null,
      output: { mode: "aggregation", closedBoxes: 74, containedUnits: 888 },
    },
  ],
};

/**
 * «Требует внимания»: причина late_data с count 1 -> и в verdict.reasons,
 * и в quality.reasons, и у одной смены в списке lateDataAt непустой.
 */
const DASHBOARD_ATTENTION = {
  ...DASHBOARD_UNDER_CONTROL,
  verdict: {
    status: "needs_attention",
    reasons: [{ code: "late_data", severity: "needs_attention", count: 1, route: "/shifts" }],
  },
  dynamics: {
    ...DASHBOARD_UNDER_CONTROL.dynamics,
    quality: {
      ...DASHBOARD_UNDER_CONTROL.dynamics.quality,
      reasons: ["active_shifts", "late_data"],
      lateDataShiftCount: 1,
    },
  },
};
```

Если рендер потребует непустые `buckets` — заполнить их той же честной арифметикой (сумма бакетов = окно), не отключая ничего в странице.

- [ ] **Step 2: Фикстуры смен и отчётов**

```ts
const CLOSED_SHIFT = {
  ...ACTIVE_SHIFT,
  id: "80000000-0000-4000-8000-000000000003",
  number: "SEP26-003",
  status: "closed",
  plannedDate: "2026-09-01",
  productionDate: "2026-09-01",
  openedAt: "2026-09-01T04:05:00.000Z",
  closedAt: "2026-09-01T12:40:00.000Z",
  closeReason: "Смена завершена по плану",
  createdAt: "2026-08-31T14:00:00.000Z",
};
const LATE_SHIFT = {
  ...CLOSED_SHIFT,
  id: "80000000-0000-4000-8000-000000000004",
  number: "SEP26-002",
  lateDataAt: "2026-09-01T14:05:00.000Z",
};
```

Форматы отчётов — РОВНО реальный каталог `SHIFT_EXPORT_FORMATS` из `packages/domain/src/shift-exports.ts` (5 позиций: «[TXT][Без коробов] Отчет смены», «[TXT][С коробами] Отчет смены», «[CSV][Без коробов] Отчет смены», «[CSV][С коробами] Отчет смены», «[XML][ГИСМТ] Отчет об агрегации») — импортировать из `@markiro/domain`, не перепечатывать. Экспорты (`ShiftExportDto`, `shift-exports-api.ts:21-41` — форма дословно):

```ts
const EXPORT_READY = {
  id: "a0000000-0000-4000-8000-000000000001",
  shiftId: CLOSED_SHIFT.id,
  formatId: "shift_xml_gismt_aggregation",
  formatVersion: 1,
  maxLines: 1000,
  status: "ready",
  errorCode: null,
  productNameSnapshot: PRODUCT.name,
  shiftDateSnapshot: "2026-09-01",
  totalCodeCount: 888,
  totalBoxCount: 74,
  createdByUserId: "browser_manager",
  createdByName: "Игорь Волков",
  sourceSnapshotStartedAt: "2026-09-01T12:45:00.000Z",
  completedAt: "2026-09-01T12:45:40.000Z",
  attemptCount: 1,
  createdAt: "2026-09-01T12:45:00.000Z",
  stale: false,
  artifacts: [
    { id: "b0000000-0000-4000-8000-000000000001", partNumber: 1, physicalLineCount: 640, codeCount: 600, boxCount: 50, filename: "shift-SEP26-003-aggregation-part1.xml", mimeType: "application/xml; charset=utf-8", byteSize: 118400, sha256: "0123456789abcdef".repeat(4) },
    { id: "b0000000-0000-4000-8000-000000000002", partNumber: 2, physicalLineCount: 322, codeCount: 288, boxCount: 24, filename: "shift-SEP26-003-aggregation-part2.xml", mimeType: "application/xml; charset=utf-8", byteSize: 61240, sha256: "89abcdef01234567".repeat(4) },
  ],
};
const EXPORT_PROCESSING = { ...EXPORT_READY, id: "a0000000-0000-4000-8000-000000000002", formatId: "shift_csv_boxes", formatVersion: 1, maxLines: null, status: "processing", completedAt: null, sourceSnapshotStartedAt: "2026-09-01T12:50:00.000Z", createdAt: "2026-09-01T12:50:00.000Z", artifacts: [] };
const EXPORT_FAILED = { ...EXPORT_READY, id: "a0000000-0000-4000-8000-000000000003", formatId: "shift_txt_boxes", formatVersion: 2, status: "failed", errorCode: "BOX_COVERAGE_INCOMPLETE", completedAt: null, totalCodeCount: null, totalBoxCount: null, artifacts: [], attemptCount: 2, createdAt: "2026-09-01T12:47:00.000Z" };
const EXPORT_STALE = { ...EXPORT_READY, id: "a0000000-0000-4000-8000-000000000004", stale: true, createdAt: "2026-09-01T13:20:00.000Z" };
```

Точные значения `formatId` сверить с `ShiftExportFormatId` в `packages/domain/src/shift-exports.ts:12` и поправить при расхождении — это юнион, а не строки на веру.

- [ ] **Step 3: Сценарии перехвата**

Расширить `Scenario` и `installApi`: `dashboardCalm`/`dashboardAttention` → `/api/dashboard/overview` (query `period=today`; матчить по pathname); `shiftsClose` → `/api/shifts` с `[ACTIVE_SHIFT]` + справочники формы (как в 08); `shiftsLate` → `[LATE_SHIFT, CLOSED_SHIFT, ACTIVE_SHIFT]`; `exports*` → `/api/shifts` + `/api/shift-exports/formats` (реальный каталог) + `/api/shifts/${CLOSED_SHIFT.id}/exports` с нужным набором. Дашборд-страница может тянуть дополнительные шелл-эндпоинты — неучтённые всплывут в `unexpected`, добавлять по фактическому списку, формы — по контрактам соответствующих `api.ts`.

- [ ] **Step 4: Девять тестов**

По образцу 08 (`openHarness`, `settle`, `screenshotFullMain`). Ассерты — по видимым строкам:

```ts
test("dashboard: under control", async ({ page }) => {
  const unexpected = await installApi(page, "dashboardCalm");
  await openHarness(page, "/");
  await expect(page.getByText("Производство под контролем")).toBeVisible();
  await expect(page.getByText("Активных причин для вмешательства нет.")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("dashboard-under-control"));
  expect(unexpected).toEqual([]);
});

test("dashboard: needs attention over late data", async ({ page }) => {
  const unexpected = await installApi(page, "dashboardAttention");
  await openHarness(page, "/");
  await expect(page.getByText("Требует внимания")).toBeVisible();
  await expect(page.getByText("Поздние данные затронули 1 смену")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("dashboard-attention"));
  expect(unexpected).toEqual([]);
});

test("shifts list: active shift with close action", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsClose");
  await openHarness(page, "/shifts");
  await expect(page.getByText("SEP26-004")).toBeVisible();
  await expect(page.getByRole("button", { name: "Закрыть смену" })).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shifts-active"));
  expect(unexpected).toEqual([]);
});

test("closing a shift asks for a reason", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsClose");
  await openHarness(page, "/shifts");
  await page.getByRole("button", { name: "Закрыть смену" }).click();
  await expect(page.getByText("Причина закрытия")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-close"));
  expect(unexpected).toEqual([]);
});

test("late data badge on a closed shift", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsLate");
  await openHarness(page, "/shifts");
  await expect(page.getByText("Данные после закрытия")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shifts-late-badge"));
  expect(unexpected).toEqual([]);
});
```

Отчёты: открыть диалог кнопкой «Сформировать отчет» у `CLOSED_SHIFT`; кадры `exports-catalog` (каталог 5 форматов + «Разделить отчет на части»), `exports-history` (READY с частями + PROCESSING; «Готов», «Формируется», «Часть 1», «Скачать», «Скачать ZIP» — проверить фактическое имя кнопки скачивания всех частей по i18n `pages.shifts.exports`), `exports-failed` (FAILED: «Не все коды смены распределены по коробам.» + «Повторить»), `exports-stale` (READY со `stale: true`: «Данные смены изменились — сформируйте новый отчет.»). Разные наборы истории — разными сценариями, чтобы каждый кадр был минимален.

- [ ] **Step 5: Прогнать и посмотреть**

```bash
cd tools/production-browser && pnpm exec playwright test --config production.playwright.config.ts
```

Expected: все тесты 08 + 09 PASS (08 — байтово нетронуты: `git status --porcelain packages/legal-documents/assets/instructions/mkr-ins-08` пуст; дрожание откатывать `git checkout --`). Прочитать инструментом Read КАЖДЫЙ из девяти новых PNG и записать в отчёт, что видно. Особо: на `dashboard-attention` причина «Поздние данные…» реально показана; на `exports-failed` текст ошибки и «Повторить» видны; ничего не обрезано.

- [ ] **Step 6: Commit**

```bash
git add tools/production-browser packages/legal-documents/assets/instructions/mkr-ins-09
git commit -m "test(production-browser): MKR-INS-09 shift monitoring and reports screenshots"
```

---

### Task 2: Контент, реестр, CLI

**Files:**
- Create: `packages/legal-documents/src/documents/cabinet-shift-close.ts`
- Modify: `packages/legal-documents/src/types.ts` (union), `packages/legal-documents/src/registry.ts`, `packages/legal-documents/src/cli/verify-artifacts.ts` (список кодов + `SAFE_FILE_NAME`)
- Test: `packages/legal-documents/test/registry.test.ts`, `packages/legal-documents/test/artifact-manifest.test.ts`

**Interfaces:**
- Consumes: девять идентификаторов кадров из Task 1.
- Produces: `CABINET_SHIFT_CLOSE_CONTENT` (`{ ru: {...} } satisfies LegalDocumentSource["content"]`, образец — `cabinet-shift-planning.ts`).

- [ ] **Step 1: Перечисления**

`types.ts`: `| "MKR-INS-09";` в конец юниона. `registry.ts`: код в `LEGAL_DOCUMENT_CODES`, `"MKR-INS-09": "instruction"` в kind-карту, релиз:

```ts
  {
    code: "MKR-INS-09",
    revision: "2026.09/01",
    effectiveDate: "2026-09-02",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/smena-zakrytie/" },
  },
```

источник `{ releaseKey: "MKR-INS-09/2026.09/01", content: CABINET_SHIFT_CLOSE_CONTENT }` + импорт. `verify-artifacts.ts`: код в список, `SAFE_FILE_NAME` → `ins-0[123456789]` (то же в `apps/landing/src/lib/legal-artifacts.ts` — Task 3).

- [ ] **Step 2: Пины пакета**

`registry.test.ts`: список кодов + `.toBe(16)` → `.toBe(17)` (маршруты) + assert `effectiveDate` для MKR-INS-09 = `2026-09-02`; матрица `reissuedRevision` НЕ меняется — вместо этого дефолт `?? "2026.08/01"` не подходит новому коду: расширить матрицу записью `"MKR-INS-09": "2026.09/01"` (это карта фактических ревизий, судя по её испольованию — свериться с текущим кодом теста и вписать так, как он устроен). `artifact-manifest.test.ts`: фикстура `artifactEntry` — ревизия `2026.09/01` и дата `2026-09-02` для MKR-INS-09, `artifacts.push(...)`, validated-ключ `MKR-INS-09|ru|legal-pdf|https://markiro.app/d/MKR-INS-09/2026.09/01/02.09.2026`, наборы ревизий (+`2026.09/01`) и дат (+`2026-09-02`), счётчики 20 → 21 и 16 → 17 (readdir/entries/requests/converted — искать текущие значения grep'ом, менять только те, что означают эти величины; DOCX остаётся 4).

- [ ] **Step 3: Контент**

Семь секций по спеке; блоки `paragraph | ordered-list | unordered-list | definition-list | step | callout`. Заголовок `"Кабинет: наблюдение, закрытие и отчёты смены"`. Ключевые требования:

1. `purpose` — статусы «Активна» → «Закрыта»; открытие и цикл — MKR-INS-01/02, подготовка — MKR-INS-08; callout про демонстрационные данные (дословно как в серии).
2. `monitoring` — дашборд «Производство сегодня»: вердикт (кадры `dashboard-under-control`, `dashboard-attention`), причины, счётчики дня, сигнал «Активная смена: данные могут измениться» — почему цифры не окончательны; список активных смен на дашборде; динамика/темп — одним предложением «вне этого документа».
3. `closing` — штатный путь: оператор со станции (MKR-INS-02); кабинетное «Закрыть смену» (кадры `shifts-active`, `shift-close`) — когда станция недоступна; «Причина закрытия» обязательна и сохраняется в смене; закрыть можно только активную.
4. `late-data` — бейдж «Данные после закрытия» (кадр `shifts-late-badge`): что это, почему появляется, что делать (сверить отчёты — см. следующий раздел).
5. `exports` — «Сформировать отчет» доступен у закрытой смены; каталог форматов ДОСЛОВНО по кадру (5 позиций), «Разделить отчет на части»/«Максимум строк в части» (2…1 000 000 — формулировку валидации взять из `exports.validation.lineLimit`), история со статусами, «Часть N», скачивание, «Повторить» — доступен у ЛЮБОГО неудавшегося формирования (проверено: `ShiftExportsDialog.tsx:250-266` рисует кнопку для всякого `failed` — НЕ переносить сюда условность из инвентаризационных документов). Кадры `exports-catalog`, `exports-history`, `exports-failed`.
6. `export-errors` — definition-list по `pages.shifts.exports.errors.*`: для каждого кода — формулировка UI дословно + действие менеджера (закрыть смену; распределить коды по коробам на станции; заполнить ИНН в профиле организации; поднять лимит строк части; обратиться в поддержку при INVALID_SSCC/INVALID_CIS; повторить при инфраструктурных). Плюс stale (кадр `exports-stale`): «Данные смены изменились — сформируйте новый отчет.» — связка с поздними данными.
7. `faq` + контакты (`hello@v-b.tech`).

СТОП-УСЛОВИЕ: каждая ёлочная цитата — `grep -F` по `apps/admin/src/i18n/ru.json` И виднa на кадре своего шага (кадр открыть Read'ом). Термины definition-list не заканчиваются пунктуацией (правило `content-contract.test.ts`).

- [ ] **Step 4: Гейты и commit**

```bash
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
git add packages/legal-documents && git commit -m "feat(legal-documents): MKR-INS-09 shift monitoring and reports content"
```

Expected: тесты пакета зелёные (сейчас 129 + новые проверки).

---

### Task 3: Лендинг

**Files:**
- Create: `apps/landing/src/pages/instruktsii/smena-zakrytie/index.astro`
- Modify: `apps/landing/src/content/legal-pages.ts`, `apps/landing/src/lib/legal-artifacts.ts:39` (`ins-0[123456789]`)
- Test: `apps/landing/src/lib/legal-artifacts.test.ts`, `apps/landing/src/lib/seo.test.ts`, `apps/landing/test/legal-rendered-page.test.ts`

- [ ] **Step 1: Страница** — строго по образцу `smena-planirovanie/index.astro`: девять импортов `...mkr-ins-09/<id>.png?url`, карта `images` с теми же идентификаторами (дефисные ключи в кавычках), `<InstructionDocument page={getLegalDocumentPage("MKR-INS-09", "ru")} images={images} />`.

- [ ] **Step 2: Описание** в `DESCRIPTION_BY_CODE` после MKR-INS-08:

```ts
  "MKR-INS-09": {
    ru: "Печатная инструкция менеджера: наблюдение за производством, закрытие смены из кабинета, данные после закрытия, отчёты для ГИС МТ и разбор их отказов.",
    en: "Printable manager instruction: production monitoring, closing a shift from the cabinet, late data, GIS MT reports, and resolving their failures.",
  },
```

- [ ] **Step 3: Пины лендинга** — `legal-artifacts.test.ts:45-46` 20 → 21 и 16 → 17 (`template-docx` = 4 не трогать); `legal-rendered-page.test.ts:173-174` 12 → 13 и 14 → 15 + `"MKR-INS-09"` в completeness-список; `seo.test.ts:84` и `:144` 64 → 66. Иное фактическое число — записать в отчёт, не подгонять.

- [ ] **Step 4: Гейты и commit**

```bash
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
git add apps/landing && git commit -m "feat(landing): MKR-INS-09 shift monitoring and reports page"
```

Expected: `seo.test.ts` зелёный уже сейчас; сьюты, читающие манифест, КРАСНЫЕ с `assertCompleteReleaseSet` до Task 4 — ожидаемо, не ослаблять.

---

### Task 4: Артефакт и аттестация

**Files:**
- Modify (генерируется): `apps/landing/public/legal/artifacts.json`; Create: `apps/landing/public/legal/files/markiro_mkr-ins-09_2026.09-01_ru.pdf`
- Modify: `deploy/production/legal-artifacts-attestation.json`, `deploy/production/verify-legal-artifacts.mjs`
- Test: `deploy/production/test/legal-artifact-attestation.test.mjs`, `deploy/production/test/edge-contract.test.mjs`

- [ ] **Step 1: Генерация** — `rm -rf apps/landing/public/legal`, затем `SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate` (docker-команды вне sandbox, таймауты до 600000 мс). Expected: `Validated 21 immutable legal artifacts`.
- [ ] **Step 2: Гейт** — `git status --porcelain apps/landing/public/legal` → ТОЛЬКО `M artifacts.json` + новый PDF. Прочие PDF при чистом дрейфе упаковки гейт `artifacts:verify` пропустит сам с предупреждением (`assertContentEquivalentPdf`), но если статус показывает `M` у другого файла — остановиться и разобраться, содержимое это или упаковка (предупреждение verify называет файлы; изменение содержимого = BLOCKED).
- [ ] **Step 3: Верификация и чтение** — `artifacts:verify` → `Verified 21 immutable legal artifacts`; прочитать PDF (стр. 1–4): титул «Кабинет: наблюдение, закрытие и отчёты смены», шапка `MKR-INS-09 · 2026.09/01`, девять кадров с подписями, < 12 MiB.
- [ ] **Step 4: Аттестация** — `shasum -a 256` манифеста и PDF; `legal-artifacts-attestation.json`: `releaseId` → `MKR-LEGAL-2026.08-14-2026-09-02`, `manifestSha256`, запись ins-09 в лексикографическую позицию (после ins-08); `verify-legal-artifacts.mjs`: `RELEASE_ID` + имя в `EXPECTED_PDFS`; `legal-artifact-attestation.test.mjs`: id, sha, имя, счётчики 16 → 17; `edge-contract.test.mjs:950`: 20 → 21.
- [ ] **Step 5: Полные гейты**

```bash
pnpm test:production-bundle:contract
pnpm --filter @markiro/landing build
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
pnpm format:check
```

Expected: всё PASS; в dist новая страница несёт 9 `<img>`/9 `<figcaption>`, `/legal/index.html` — MKR-INS-01…09. Падение admin/saas-admin typecheck с чужими путями = несобранные пакеты (`pnpm turbo run build --filter=@markiro/platform-contracts --filter=@markiro/ui --filter=@markiro/domain`), не регрессия.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/public/legal deploy/production
git commit -m "feat(legal): publish MKR-INS-09 artifact and attest the new release set"
```

---

## Self-Review Notes

- Покрытие спеки: раздел 1 → Task 2; раздел 2 (кадры) → Task 1; раздел 3 (конвейер) → Task 2/3/4; риски раздела 4 зашиты стоп-условиями Task 1 Step 5 и Task 2 Step 3.
- Идентификаторы кадров перечислены одинаково в Task 1 (Produces), Task 2 Step 3 и Task 3 Step 1 — девять, каждый один раз.
- Против уроков серии: вердикт дашборда производен от данных фикстуры (Task 1 Step 1 связывает verdict/quality/lateDataAt); «Повторить» у отчётов безусловен — проверено по `ShiftExportsDialog.tsx:250-266` и явно противопоставлено инвентаризации; формат-каталог импортируется из `@markiro/domain`, а не перепечатывается; номера смен `SEP26-NNN` — формат кода.
- Числа перемерены на `5ce4974df`; матрица `reissuedRevision` — реализатору Task 2 явно сказано свериться с фактическим устройством теста.
- Процессное требование: финальному whole-branch ревью — линза «текст ↔ скриншоты ↔ i18n» (задаёт контролёр при диспатче).
