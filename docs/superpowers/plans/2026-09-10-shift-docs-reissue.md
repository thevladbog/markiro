# Переиздание MKR-INS-08 и MKR-INS-09 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вернуть сменные инструкции к правде: описать панель «Подробнее», печать дубликата Data Matrix, историю этикеток и строку фактического выпуска, переснять устаревшие кадры и переиздать оба документа новыми ревизиями.

**Architecture:** Съёмочная спека переводится на путь «строка → Подробнее → секция панели» и дополняется сценариями дубликата и истории этикеток; тексты обоих документов правятся по свежим кадрам; релиз остаётся 27 файлов, два из них заменяются переизданными.

**Tech Stack:** TypeScript (ESM), Playwright (`tools/production-browser`, `--ignore-workspace`), vitest, LibreOffice 26.2.5 + veraPDF (docker), пиненные IBM Plex.

**Spec:** `docs/superpowers/specs/2026-09-10-shift-docs-reissue-design.md`

## Global Constraints

- Ревизии: MKR-INS-08 `2026.08/01` → `2026.09/01`, MKR-INS-09 `2026.09/01` → `2026.09/02`; дата вступления обеих — `2026-09-10`. Маршруты, коды и число артефактов не меняются.
- Релиз остаётся 27 файлов (23 PDF): два файла заменяются под новыми именами, остальные 25 обязаны остаться байт-в-байт.
- Кадры живут в `packages/legal-documents/assets/instructions/mkr-ins-0{8,9}/ru/`.
- **RU-кадры дрейфуют субпиксельно** при каждом прогоне. Кадр считается изменившимся, только если изменилось содержание; кадры с одним лишь дрейфом откатывать `git checkout -- <path>`. Быстрая проверка: `magick compare -metric PAE old new null:` — дрейф даёт пиковое отличие в единицы из 255, содержательное изменение видно глазами.
- Перед браузерными спеками собрать контракты: `pnpm --filter @markiro/platform-contracts build` (иначе админка падает белым экраном на устаревшем `dist`).
- Playwright, docker и `gh` запускать вне песочницы (`dangerouslyDisableSandbox: true`): песочница блокирует `listen`, docker-сокет и TLS к api.github.com.
- Генерация артефактов: `SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate`; байт-сверка — тот же CLI с `--check`.
- Каждая «guillemet»-цитата обоих документов обязана быть в `apps/admin/src/i18n/ru.json` и видна на кадре своего шага.
- Не использовать `git stash`; перед коммитами — `pnpm format:check`.

---

### Task 1: Спека — путь через панель «Подробнее»

**Files:**

- Modify: `tools/production-browser/tests/production.visual.spec.ts`

**Interfaces:**

- Produces: мок `GET /api/shifts/:id/summary`, хелпер открытия панели; семь сценариев (удаление, закрытие, четыре отчётных, активная смена) работают через панель. Task 2 добавляет к ним сценарии дубликата.

- [ ] **Step 1: Фикстура сводки смены**

`ShiftSummaryDto` (`apps/admin/src/pages/shifts/api.ts:118`) зодом не парсится, но панель читает поля напрямую — форма должна совпадать:

```ts
const SHIFT_SUMMARY = {
  generatedAt: "2026-09-02T11:20:00.000Z",
  output: { mode: "aggregation", closedBoxes: 96, containedUnits: 1152 },
  participants: [
    {
      employeeId: "60000000-0000-4000-8000-000000000001",
      fullName: "Мария Кузнецова",
      role: "Оператор линии",
      firstActivityAt: "2026-09-02T04:15:00.000Z",
      lastActivityAt: "2026-09-02T11:05:00.000Z",
      acceptedScans: 812,
      closedBoxes: 68,
    },
    {
      employeeId: "60000000-0000-4000-8000-000000000002",
      fullName: "Пётр Смирнов",
      role: null,
      firstActivityAt: "2026-09-02T04:20:00.000Z",
      lastActivityAt: "2026-09-02T10:40:00.000Z",
      acceptedScans: 340,
      closedBoxes: 28,
    },
  ],
  unattributed: { eventCount: 4, acceptedScans: 4, closedBoxes: 0 },
};
```

Поля `ShiftParticipantDto` сверить с `apps/admin/src/pages/shifts/api.ts` перед прогоном: неверное имя поля даст пустую ячейку, а не ошибку.

- [ ] **Step 2: Мок в `installApi`**

Добавить рядом с `/api/shifts`:

```ts
if (/^\/api\/shifts\/[0-9a-f-]+\/summary$/.test(path)) return json(route, SHIFT_SUMMARY);
```

Для закрытой смены (сценарии отчётов) вернуть ту же сводку — метрики закрытой смены к отчётам отношения не имеют.

- [ ] **Step 3: Хелпер открытия панели**

```ts
/**
 * Every row action moved into the details panel (`e177cea30`): the list now
 * carries only «Подробнее». Tests that used to click an action in the row
 * open the panel first.
 */
async function openShiftDetails(page: Page, shiftNumber: string) {
  await page
    .getByRole("row", { name: new RegExp(shiftNumber) })
    .getByRole("button", { name: "Подробнее" })
    .click();
  await expect(page.getByRole("heading", { name: `Смена ${shiftNumber}` })).toBeVisible();
}
```

Точную форму заголовка панели сверить с ключом `pages.shifts.details.title` — если он параметризован иначе, поправить по факту.

- [ ] **Step 4: Перевести семь сценариев**

Тесты, которые кликают действия в строке (по разведке — «deleting a planned shift…», «shifts list: active shift offers the close action», «closing a shift…», четыре «report dialog: …»), переписать по образцу:

```ts
test("closing a shift from the cabinet asks for a reason", async ({ page }) => {
  const unexpected = await installApi(page, "shiftsClose");
  await openHarness(page, "/shifts");
  await openShiftDetails(page, "SEP26-004");
  await page.getByRole("button", { name: "Закрыть смену" }).click();
  await expect(page.getByLabel("Причина закрытия")).toBeVisible();
  await page.getByLabel("Причина закрытия").fill("Смена завершена по плану");
  await screenshotFullMain(page, screenshotPath09("shift-close"));
  expect(unexpected).toEqual([]);
});
```

Отчётные сценарии открывают панель закрытой смены — секция «Отчеты смены» рендерится там сразу, отдельного клика-триггера больше нет (ключ `exports.action` осиротел).

- [ ] **Step 5: Прогнать спеку**

```bash
pnpm --filter @markiro/platform-contracts build
cd tools/production-browser && pnpm --ignore-workspace test:production
```

Expected: все тесты PASS, `unexpected` пуст. Падение на `unexpected` показывает недостающий эндпоинт — добавить мок и повторить.

- [ ] **Step 6: Отсеять дрейф и посмотреть кадры**

```bash
git status --short packages/legal-documents/assets/instructions/
```

Для каждого изменившегося кадра решить: содержательное изменение (оставить) или дрейф (`git checkout --`). Проверять `magick compare -metric PAE` и глазами.

- [ ] **Step 7: Commit**

```bash
git add tools/production-browser packages/legal-documents/assets
git commit -m "test(shifts): drive the visual evidence through the details panel"
```

---

### Task 2: Спека — дубликат Data Matrix и история этикеток

**Files:**

- Modify: `tools/production-browser/tests/production.visual.spec.ts`

**Interfaces:**

- Consumes: хелперы Task 1.
- Produces: кадры `shift-duplicate-print` (08), `shift-details-result` и `shift-labels-history` (09).

- [ ] **Step 1: Фикстуры дубликата**

```ts
const PRODUCT_LABEL_TEMPLATE_ID = "40000000-0000-4000-8000-000000000002";
// Валидируется строгой схемой productLabelTemplateListSchema
// (packages/domain/src/product-labels/contracts.ts:147) -- лишнее поле уронит форму.
const PRODUCT_LABEL_TEMPLATES = {
  items: [
    {
      id: PRODUCT_LABEL_TEMPLATE_ID,
      name: "Дубликат Data Matrix 58×40 [Краткое наименование]",
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
    },
  ],
};
const DUPLICATE_PLANNING_CONFIG = {
  ...SHIFT_PLANNING_CONFIG,
  validationPrintProtocol: "validation-dm-duplicate-v1",
};
const DUPLICATE_SHIFT = {
  ...ACTIVE_SHIFT_09,
  mode: "validation",
  output: { mode: "validation", acceptedUnits: 1240 },
  validationPrint: {
    mode: "duplicate_dm",
    templateId: PRODUCT_LABEL_TEMPLATE_ID,
    verification: "required",
    snapshot: { name: "Дубликат Data Matrix 58×40 [Краткое наименование]" },
  },
};
```

Форму `validationPrint` и `SHIFT_PLANNING_CONFIG` сверить с `apps/admin/src/pages/shifts/api.ts` (`ValidationPrintPolicy`, `planning-config`) — брать поля дословно.

- [ ] **Step 2: Фикстура истории этикеток**

Строгая схема `productLabelHistorySchema` (`packages/domain/src/product-labels/history.ts:20`) — поля ровно эти:

```ts
const PRODUCT_LABEL_HISTORY = {
  summary: { sentAttempts: 1240, verifiedAttempts: 1238, unresolvedJobs: 1, reprintAttempts: 3 },
  items: [
    {
      jobId: "a0000000-0000-4000-8000-000000000001",
      deviceId: STATION_ID,
      codeSuffix: "…0128",
      acceptedAt: "2026-09-02T11:04:00.000Z",
      status: "completed",
      verificationOutcome: "verified",
      attemptNo: 1,
      ownershipConflict: false,
    },
    {
      jobId: "a0000000-0000-4000-8000-000000000002",
      deviceId: STATION_ID,
      codeSuffix: "…0129",
      acceptedAt: "2026-09-02T11:05:00.000Z",
      status: "attention",
      verificationOutcome: "pending",
      attemptNo: 2,
      ownershipConflict: false,
    },
  ],
  nextCursor: null,
};
```

`codeSuffix` — не длиннее 6 символов (`z.string().max(6)`).

- [ ] **Step 3: Моки**

Добавить в `installApi` для новых сценариев: `GET /api/shifts/product-label-templates` → `PRODUCT_LABEL_TEMPLATES`; `GET /api/shifts/planning-config` → `DUPLICATE_PLANNING_CONFIG`; `GET /api/shifts/:id/product-labels` → `PRODUCT_LABEL_HISTORY`; `GET /api/operators` → `{ items: [...] }` с теми же `employeeId`/`fullName`, что в сводке.

- [ ] **Step 4: Три теста**

```ts
test("planning a validation shift offers the Data Matrix duplicate", async ({ page }) => {
  const unexpected = await installApi(page, "shiftDuplicate");
  await openHarness(page, "/shifts/new");
  await page.getByRole("combobox", { name: "Продукт" }).click();
  await page.getByRole("option", { name: PRODUCT.name, exact: true }).click();
  await page.getByRole("radio", { name: "Валидация" }).check();
  await page.getByRole("radio", { name: "Дублировать Data Matrix" }).check();
  await expect(page.getByText("Шаблон этикетки продукции")).toBeVisible();
  await screenshotFullMain(page, screenshotPath("shift-duplicate-print"));
  expect(unexpected).toEqual([]);
});
```

Аналогично: `shift-details-result` — открыть панель активной смены и снять её (видны «Результат смены» и «Сотрудники в смене»); `shift-labels-history` — панель смены с дубликатом, секция «История этикеток». Подписи проверить в `ru.json` (`pages.shifts.duplicate.*`, `pages.shifts.details.*`, `pages.shifts.productLabels.*`) — брать дословно.

- [ ] **Step 5: Прогон, отсев дрейфа, commit**

```bash
cd tools/production-browser && pnpm --ignore-workspace test:production
```

Expected: все тесты PASS. Затем отсеять дрейф (как в Task 1 Step 6) и:

```bash
git add tools/production-browser packages/legal-documents/assets
git commit -m "test(shifts): capture duplicate printing, shift result and label history"
```

---

### Task 3: Текст MKR-INS-08

**Files:**

- Modify: `packages/legal-documents/src/documents/cabinet-shift-planning.ts`

- [ ] **Step 1: Сверить кадры и выписать цитаты**

Открыть (`Read`) все кадры `mkr-ins-08/ru/` и выписать, какие строки на них видны. Цитировать можно только это.

- [ ] **Step 2: Правки по разделам**

- §5 «Планирование»: перечисление разделов формы дополнить «Печатью дубликата»; сказать, что «Шаблоны» показывается, только когда дубликат выключен.
- §7 «Режим и агрегация»: убрать обещание «в строке будут доступны «Изменить» и «Удалить»» и «у активной смены вместо удаления появляется «Закрыть смену»» — теперь в строке только «Подробнее», а действия в панели, в секции «Действия со сменой».
- §8 «Изменение и удаление»: переписать путь к кнопкам через панель; правило «удалить можно только запланированную» сохранить.
- Новый раздел «Печать дубликата Data Matrix» после §7: переключатель «Печать этикетки» («Без печати» / «Дублировать Data Matrix»), когда вторая опция недоступна, «Шаблон этикетки продукции», «Обязательная проверка этикетки» и что она требует от оператора, фиксация параметров при открытии смены. Кадр `shift-duplicate-print`.
- §5 или §7: строка фактического выпуска в списке смен.

- [ ] **Step 3: Прогнать тесты пакета**

Run: `pnpm --filter @markiro/legal-documents test`
Expected: `instruction-assets` и `content-contract` зелёные (набор image id совпал с файлами, латинского «Markiro» в русском тексте нет). Манифестные тесты падают до Task 6 — это ожидаемо.

- [ ] **Step 4: Commit** — `docs(legal): update MKR-INS-08 for the details panel and duplicate printing`.

---

### Task 4: Текст MKR-INS-09

**Files:**

- Modify: `packages/legal-documents/src/documents/cabinet-shift-close.ts`

- [ ] **Step 1: Сверить кадры и выписать цитаты** — как в Task 3, по `mkr-ins-09/ru/`.

- [ ] **Step 2: Правки по разделам**

- Новый раздел «Панель смены» после наблюдения: как открыть («Подробнее»), «Результат смены» с метриками («Принято кодов» либо «Закрыто коробов» и «Кодов в закрытых коробах», «План, шт»), «Сотрудники в смене», предупреждение о неатрибутированных операциях, поведение при сбое загрузки статистики. Кадр `shift-details-result`.
- Новый раздел «История этикеток» для смен с дубликатом. Кадр `shift-labels-history`.
- §3 «Закрытие смены»: путь строка → «Подробнее» → «Действия со сменой» → «Закрыть смену»; порог причины — меньше трёх значащих символов оставляет подтверждение неактивным; правило «только у активной» сохранить.
- §5 «Отчёты»: не окно, а секция «Отчеты смены» в панели; у незакрытой смены — подсказка «Заказать и выгрузить отчеты можно после закрытия смены.»; каталог форматов, разделение, история и «Повторить» оставить дословно.
- Добавить: у закрытой смены секции «Действия со сменой» нет вовсе.
- §7 «Частые вопросы»: пересобрать под новые пути.

- [ ] **Step 3: Прогнать тесты пакета** — как в Task 3 Step 3.

- [ ] **Step 4: Commit** — `docs(legal): update MKR-INS-09 for the details panel, result and reports`.

---

### Task 5: Переиздание в реестре

**Files:**

- Modify: `packages/legal-documents/src/registry.ts`
- Modify: `packages/legal-documents/test/registry.test.ts`

- [ ] **Step 1: Новые ревизии**

В `LEGAL_RELEASES` у MKR-INS-08 — `revision: "2026.09/01"`, `effectiveDate: "2026-09-10"`; у MKR-INS-09 — `revision: "2026.09/02"`, `effectiveDate: "2026-09-10"`. В `LEGAL_DOCUMENTS` обновить `releaseKey` обеих записей.

- [ ] **Step 2: Пины тестов**

В `registry.test.ts`: в `reissuedRevision` — `"MKR-INS-08": "2026.09/01"`, `"MKR-INS-09": "2026.09/02"` с комментарием о причине переиздания; `findLegalRelease("MKR-INS-08").effectiveDate` и `…-09` → `"2026-09-10"`; при необходимости поправить фильтр исключений по датам.

- [ ] **Step 3: Тесты и commit**

Run: `pnpm --filter @markiro/legal-documents test`
Expected: всё, кроме манифестных, зелёное.

```bash
git add packages/legal-documents/src/registry.ts packages/legal-documents/test/registry.test.ts
git commit -m "feat(legal): reissue MKR-INS-08 and MKR-INS-09 for the reworked shift screen"
```

---

### Task 6: Артефакты и аттестация

**Files:**

- Modify: `apps/landing/public/legal/`, `packages/legal-documents/test/artifact-manifest.test.ts`
- Modify: `deploy/production/legal-artifacts-attestation.json`, `verify-legal-artifacts.mjs`, `test/legal-artifact-attestation.test.mjs`

- [ ] **Step 1: Перегенерация**

```bash
rm -rf apps/landing/public/legal
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
git status --short apps/landing/public/legal
```

Expected: «Validated 27 immutable legal artifacts»; в статусе — два удалённых старых файла 08/09, два новых и изменённый `artifacts.json`. Если изменился ещё какой-то из 25 — STOP.

- [ ] **Step 2: Verify**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: «Verified 27 immutable legal artifacts».

- [ ] **Step 3: Манифестные фикстуры**

В `artifact-manifest.test.ts`: MKR-INS-08 и MKR-INS-09 переносятся в сентябрьские коды с нужными ревизиями (у 09 — `2026.09/02`, значит одной константы `SEPTEMBER_CODES` мало: добавить явную ветку), дата `2026-09-10` уже есть в наборе после MKR-INS-10; в списке ожидаемых запросов обновить строки 08/09 (`https://markiro.app/d/MKR-INS-08/2026.09/01/10.09.2026` и `…/MKR-INS-09/2026.09/02/10.09.2026`).

- [ ] **Step 4: Аттестация**

Пересчитать `manifestSha256`, обновить `releaseId` на `MKR-LEGAL-2026.09-18-2026-09-10`, заменить две записи в `pdfs`, два имени в `EXPECTED_PDFS`, те же правки в `test/legal-artifact-attestation.test.mjs`. Счётчики (23 PDF, 27 файлов) не меняются.

- [ ] **Step 5: Прогоны**

```bash
pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing test
node --test deploy/production/test/*.mjs
```

Expected: всё зелёное (deploy — вне песочницы).

- [ ] **Step 6: Commit** — `feat(legal): publish the reissued shift instructions and attest the release`.

---

### Task 7: Финальная верификация

- [ ] **Step 1:** `pnpm format:check`, `pnpm --filter @markiro/legal-documents lint`.
- [ ] **Step 2:** байт-сверка релиза CLI с `--check` — «Validated 27 immutable legal artifacts», дерево чистое.
- [ ] **Step 3:** повторный прогон `test:production` — зелёный, кадры не изменились (кроме дрейфа, который откатывается).
- [ ] **Step 4:** отчёт линзы по обоим документам (цитата → ключ → кадр) и список кадров, которые проверили и оставили без изменений.
