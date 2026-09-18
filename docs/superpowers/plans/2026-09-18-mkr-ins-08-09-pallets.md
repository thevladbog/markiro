# MKR-INS-08 и MKR-INS-09: переиздание под паллеты — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** переиздать обе сменные инструкции в обеих локалях так, чтобы они описывали паллеты и новый экран оборудования.

**Architecture:** чиним оснастку съёмки (`production.visual.spec.ts` не знает `GET /api/pallets`), снимаем кадры заново, правим контент обоих документов, двигаем ревизии, перевыпускаем четыре PDF и аттестацию, заводим кабинетные сьюты в CI.

**Tech Stack:** Playwright (`--ignore-workspace`), харнесс кабинета `production.html`, `@markiro/legal-documents`, LibreOffice + veraPDF, Astro-лендинг.

**Рабочее место:** worktree `/Users/thevladbog/PRSOME/q-audit`, ветка `claude/instructions-pallets-reissue` от `origin/main` (`c183661f9`). Зависимости установлены, `dist` собран, `tools/production-browser` установлен с `--ignore-workspace`.

## Global Constraints

- Ревизии двигаются: MKR-INS-08 `2026.09/01 → 2026.09/02`, MKR-INS-09 `2026.09/03 → 2026.09/04`. Даты вступления — день выпуска.
- Состав релиза не меняется: 34 файла / 30 PDF. Четыре файла меняют имя; остальные 30 остаются байт-в-байт.
- Идентификаторы секций и кадров совпадают между локалями (`content-contract.test.ts`).
- В русском тексте — «Маркиро», без латинского `Markiro`; в английском наоборот.
- Термины `definition-list` не заканчиваются знаком препинания.
- Английский текст использует длинное тире `—` там, где его печатает продукт: ASCII `--` в цитате делает её несуществующей.
- Кадры кабинета снимаются на ширине 1280.
- Перед браузерными спеками: `pnpm --filter @markiro/platform-contracts build`.
- Playwright, docker и `gh` — только с `dangerouslyDisableSandbox: true`.

## Линза: что уже известно

Инструмент `/tmp/claude-501/lens.mjs` (`node lens.mjs <root> <CODE> <ru|en> [dictDir]`) классифицирует цитаты как `exact` / `prefix` / `template` / `fragment` / `MISSING`. В нём был дефект: значение-плейсхолдер `"{{name}}"` компилировалось в `^.+$` и глушило проверку — поэтому старые прогоны показывали ноль пропусков. Дефект исправлен; при переносе инструмента в репозиторий это правило сохранить.

Текущие `MISSING` по двум документам цикла:

| Документ | Цитата                                                                                      | Вердикт                                   |
| -------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 08 ru ×2 | «Вместимость паллеты, шт»                                                                   | устарело → «Коробов на паллете»           |
| 08 en ×2 | «draft -- unavailable»                                                                      | ASCII-дефис → `draft — unavailable`       |
| 08 en    | «Decides whose numbers appear on the boxes -- not the same question as which counterparty…» | ASCII-дефис → `—`                         |
| 09 ru/en | ярлыки форматов отчётов                                                                     | принятое исключение (доменный справочник) |

---

### Task 1: Фикстуры паллет и мок `GET /api/pallets`

**Files:**

- Modify: `tools/production-browser/tests/production.visual.spec.ts`

**Interfaces:**

- Produces: `fx.PALLETS`, маршрут `/api/pallets` в `installApi`, расширенный `SHIFT_EXPORT_FORMATS_FIXTURE`.

- [ ] **Step 1: Убедиться в поломке**

```bash
cd /Users/thevladbog/PRSOME/q-audit/tools/production-browser && pnpm test:production 2>&1 | tail -5
```

Expected: 18 упавших тестов; в diff’ах `unexpected` строка `"GET /api/pallets?shiftId=…"`.

- [ ] **Step 2: Фикстура паллет**

Внутри `function fixtures(locale: AdminLocale)`, рядом с определениями смен, добавить. Поля — по `apps/admin/src/pages/shifts/pallets-api.ts`'s `PalletDto`; три состояния нужны, потому что текст описывает все три:

```ts
/**
 * Three pallets in the three states the panel can show: a plain closed one,
 * one whose member box was disassembled after the close, and a disassembled
 * pallet. Only the first is printable, which is what makes the placard rule
 * ("closed, still standing, has an SSCC") visible on the frame.
 */
const PALLETS = [
  {
    id: "90000000-0000-4000-8000-000000000001",
    sscc: "00346006820000000015",
    kind: "production" as const,
    productId: PRODUCT_ID,
    productName: PRODUCT.name,
    deviceName: copy.station,
    rejectedMembershipCount: 0,
    terminalId: null,
    lineName: LINE.name,
    operatorId: null,
    boxCount: 48,
    unitCount: 576,
    closedAt: "2026-08-30T11:20:00.000Z",
    contentsChangedAfterClose: false,
    disassembledAt: null,
  },
  {
    id: "90000000-0000-4000-8000-000000000002",
    sscc: "00346006820000000022",
    kind: "production" as const,
    productId: PRODUCT_ID,
    productName: PRODUCT.name,
    deviceName: copy.station,
    rejectedMembershipCount: 0,
    terminalId: null,
    lineName: LINE.name,
    operatorId: null,
    boxCount: 47,
    unitCount: 564,
    closedAt: "2026-08-30T12:05:00.000Z",
    contentsChangedAfterClose: true,
    disassembledAt: null,
  },
  {
    id: "90000000-0000-4000-8000-000000000003",
    sscc: "00346006820000000039",
    kind: "production" as const,
    productId: PRODUCT_ID,
    productName: PRODUCT.name,
    deviceName: copy.station,
    rejectedMembershipCount: 0,
    terminalId: null,
    lineName: LINE.name,
    operatorId: null,
    boxCount: 0,
    unitCount: 0,
    closedAt: "2026-08-30T09:40:00.000Z",
    contentsChangedAfterClose: false,
    disassembledAt: "2026-08-30T13:15:00.000Z",
  },
];
```

Добавить `PALLETS` в возвращаемый объект `fixtures()`.

- [ ] **Step 3: Маршрут**

В `installApi`, рядом с прочими общими маршрутами (до `unexpected.push`):

```ts
// `GET /pallets` 404s for an unknown shift rather than returning an empty
// list, so the panel treats an error as a real failure -- answer only the
// shifts these frames open.
if (path === "/api/pallets") {
  const shiftId = url.searchParams.get("shiftId");
  const known = [SHIFT_ID, ACTIVE_SHIFT_ID, CLOSED_SHIFT_ID, LATE_SHIFT_ID];
  if (shiftId && known.includes(shiftId)) return json(route, { items: fx.PALLETS });
  return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
}
```

- [ ] **Step 4: Каталог форматов 5 → 10**

`SHIFT_EXPORT_FORMATS_FIXTURE` — дописать пять записей, дословно по `packages/domain/src/shift-exports.ts`. Порядок и `boxMode` брать оттуда же, значения не выдумывать:

```bash
cd /Users/thevladbog/PRSOME/q-audit && grep -n "id:\|label:\|extension:\|mimeType:\|boxMode:" packages/domain/src/shift-exports.ts
```

Дописываемые идентификаторы: `shift_txt_pallets`, `shift_csv_pallets`, `shift_xml_gismt_aggregation_pallets`, `shift_txt_pallet_boxes`, `shift_xml_gismt_pallet_boxes`.

- [ ] **Step 5: Прогон**

```bash
cd /Users/thevladbog/PRSOME/q-audit/tools/production-browser && pnpm test:production 2>&1 | tail -5
```

Expected: все тесты PASS, `unexpected` пуст.

- [ ] **Step 6: Commit**

```bash
git add tools/production-browser/tests/production.visual.spec.ts
git commit -m "test(shifts): teach the shift evidence suite about pallets"
```

Кадры, изменившиеся в этом прогоне, НЕ коммитить — они относятся к Task 3.

---

### Task 2: Новые кадры

**Files:**

- Modify: `tools/production-browser/tests/production.visual.spec.ts`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-08/{ru,en}/shift-pallets.png`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-09/{ru,en}/shift-pallets.png`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-09/{ru,en}/pallet-placards.png`

- [ ] **Step 1: Кадр планирования (08)**

Форма смены уже открывается сценарием `shiftCreate`, и тест на `palletsEnabledLabel` существует. Добавить отдельный кадр раздела агрегации с включёнными паллетами:

```ts
test(`shift planning shows the pallet fields (${locale})`, async ({ page }) => {
  const unexpected = await installApi(page, "shiftCreate", fx);
  await openHarness(page, locale, "/shifts/new");
  await expect(page.getByText(t("pages.shifts.form.palletsEnabledLabel"))).toBeVisible();
  await expect(page.getByLabel(t("pages.shifts.form.palletBoxCapacityLabel"))).toBeVisible();
  await expect(page.getByText(t("pages.shifts.form.palletLabelTemplateLabel"))).toBeVisible();
  await screenshotFullMain(page, shot("shift-pallets"));
  expect(unexpected).toEqual([]);
});
```

Если поля скрыты, пока не выбран режим «Агрегация» или не отмечен флажок, — сперва выполнить те же действия, что и существующий тест агрегации; порядок брать из него, не выдумывая.

- [ ] **Step 2: Кадр секции паллет (09)**

Секция рендерится только при `shift.palletsEnabled` (`ShiftDetailsPanel.tsx:499`), а `ACTIVE_SHIFT` его уже несёт:

```ts
test(`the shift panel lists the pallets of the shift (${locale})`, async ({ page }) => {
  const unexpected = await installApi(page, "shiftsClose", fx);
  await openHarness(page, locale, `/shifts/${ACTIVE_SHIFT_ID}`);
  const pallets = page.getByRole("region", { name: t("pages.shifts.pallets.title") });
  await expect(pallets).toBeVisible();
  await expect(page.getByText(t("pages.shifts.pallets.disassembled"))).toBeVisible();
  await expect(page.getByText(t("pages.shifts.pallets.contentsChangedAfterClose"))).toBeVisible();
  await settle(page);
  await pallets.screenshot({ path: shot09("shift-pallets"), scale: "css" });
  expect(unexpected).toEqual([]);
});
```

Секция — это `<section aria-label={t("pages.shifts.pallets.title")}>`, поэтому снимается она сама: панель смены очень высокая, и полностраничный кадр повторил бы `shifts-active`.

- [ ] **Step 3: Кадр диалога ярлыков (09)**

```ts
test(`the pallet placard dialog offers its formats (${locale})`, async ({ page }) => {
  const unexpected = await installApi(page, "shiftsClose", fx);
  await openHarness(page, locale, `/shifts/${ACTIVE_SHIFT_ID}`);
  await page.getByRole("button", { name: t("pages.shifts.pallets.placards.action") }).click();
  await expect(
    page.getByRole("dialog", { name: t("pages.shifts.pallets.placards.title") }),
  ).toBeVisible();
  await screenshotFullMain(page, shot09("pallet-placards"));
  expect(unexpected).toEqual([]);
});
```

Кнопка «Ярлыки» появляется только при наличии печатаемых паллет — первая фикстура из Task 1 это обеспечивает.

- [ ] **Step 4: Прогон и просмотр**

```bash
cd /Users/thevladbog/PRSOME/q-audit/tools/production-browser && pnpm test:production 2>&1 | tail -5
ls ../../packages/legal-documents/assets/instructions/mkr-ins-09/ru | wc -l
```

Expected: все тесты PASS. Открыть шесть новых PNG и убедиться: на `mkr-ins-09/*/shift-pallets` видны все три состояния, на `pallet-placards` — выбор формата.

- [ ] **Step 5: Commit**

```bash
git add tools/production-browser/tests/production.visual.spec.ts \
        packages/legal-documents/assets/instructions/mkr-ins-08 \
        packages/legal-documents/assets/instructions/mkr-ins-09
git commit -m "test(shifts): capture the pallet planning, panel and placard frames"
```

---

### Task 3: Пересъёмка и разбор дрейфа

- [ ] **Step 1: Отделить дрейф от изменения**

После прогона Task 2 часть старых кадров окажется переписанной. Для каждого:

```bash
cd /Users/thevladbog/PRSOME/q-audit
git status --short packages/legal-documents/assets | awk '{print $2}' | while IFS= read -r f; do
  git show "HEAD:$f" > "$TMPDIR/base.png"
  v=$(magick compare -metric PAE "$TMPDIR/base.png" "$f" null: 2>&1 | grep -oE '^[0-9]+')
  printf "%-64s %s\n" "${f#packages/legal-documents/assets/instructions/}" "$v"
done
```

PAE < 5000 — субпиксельный дрейф, откатить через `git checkout -- <file>`. Больше — настоящее изменение, оставить и просмотреть.

- [ ] **Step 2: Просмотр**

Открыть каждый оставшийся кадр и записать, что именно изменилось: это список, который в Task 4 и 5 превращается в правки текста. Кадры, известные по аудиту: у 08 — `device-line`, `device-list`, `shift-active-locked`, `shift-aggregation`, `shift-delete`, `shift-duplicate-print`, `shift-filled`, `shift-product-options`; у 09 — `exports-catalog`, `exports-history`, `exports-stale`, `shift-close`, `shift-labels-history`, `shifts-active`.

- [ ] **Step 3: Commit**

```bash
git add packages/legal-documents/assets/instructions/mkr-ins-08 packages/legal-documents/assets/instructions/mkr-ins-09
git commit -m "test(shifts): reshoot the shift instruction frames against the current cabinet"
```

---

### Task 4: Контент MKR-INS-08

**Files:**

- Modify: `packages/legal-documents/src/documents/cabinet-shift-planning.ts`

- [ ] **Step 1: §3 «Станции на линии» — новый экран**

Раздел переписывается под перерисованный экран оборудования. Цитаты (ключи `pages.devices.*`, значения проверены в словаре):

| Ключ              | ru                                                                     | en                   |
| ----------------- | ---------------------------------------------------------------------- | -------------------- |
| `description`     | Состояние Station, ТСД и киосков, их подключение и лицензионные места. | (взять из `en.json`) |
| `overview.title`  | Рабочий контур                                                         | (из `en.json`)       |
| `overview.total`  | Найдено устройств                                                      | (из `en.json`)       |
| `overview.slots`  | Использование слотов                                                   | (из `en.json`)       |
| `registry.title`  | Оборудование организации                                               | (из `en.json`)       |
| `workflows.title` | Лицензии и замена устройств                                            | (из `en.json`)       |

Точные английские значения брать так:

```bash
cd /Users/thevladbog/PRSOME/q-audit && node -e "
const e=require('./apps/admin/src/i18n/en.json');const g=(p)=>p.split('.').reduce((a,k)=>a&&a[k],e);
for(const k of ['pages.devices.description','pages.devices.overview.title','pages.devices.overview.total','pages.devices.overview.slots','pages.devices.registry.title','pages.devices.workflows.title','pages.devices.workflows.description'])
  console.log(k, '=', JSON.stringify(g(k)));"
```

Содержание раздела: найти станцию в реестре, убедиться, что она в сети, привязать к линии. Лицензионные места и замена устройства — один абзац: колонка показывает занятое место, а резервы, освобождение и подготовка замены живут в «Лицензии и замена устройств» и требуют прав администратора. Существующий `callout` про права администратора сохраняется.

- [ ] **Step 2: §5 «Планирование смены» — паллеты**

Добавить шаг с кадром `shift-pallets` и точными цитатами:

- «Использовать паллеты» (`pages.shifts.form.palletsEnabledLabel`)
- «Коробов на паллете» (`palletBoxCapacityLabel`) и подсказка «Сколько закрытых коробов встаёт на одну паллету.» (`palletBoxCapacityHint`)
- «Шаблон этикетки паллеты» (`palletLabelTemplateLabel`) и «Пусто — берётся шаблон по умолчанию для категории товара, затем для организации.» (`palletLabelTemplateHint`)

Отдельный `callout` про тариф, с обеими строками дословно:

- «Паллеты не входят в текущий тариф. Чтобы включать их в сменах, добавьте функцию в подписку.» (`palletsNotEntitled`)
- «Паллеты не входят в текущий тариф. Эта смена была запланирована с паллетами: их можно выключить, но включить обратно — нет.» (`palletsNotEntitledEnabled`)

- [ ] **Step 3: §7 — исправить устаревшую цитату**

В шаге «Заполните параметры агрегации» заменить

```
Отметка «Использовать паллеты» добавляет поле «Вместимость паллеты, шт»: пока отметка снята, этого поля нет.
```

на формулировку с текущим полем «Коробов на паллете». Такая же правка нужна в §10 «Частые вопросы» — там цитата повторяется.

- [ ] **Step 4: Английские тире**

В блоке `en` заменить ASCII `--` на `—` в трёх цитатах: «draft -- unavailable» (дважды) и «Decides whose numbers appear on the boxes -- not the same question as which counterparty the goods are for.». Значения сверить с `en.json`.

- [ ] **Step 5: Линза**

```bash
node /tmp/claude-501/lens.mjs /Users/thevladbog/PRSOME/q-audit MKR-INS-08 ru
node /tmp/claude-501/lens.mjs /Users/thevladbog/PRSOME/q-audit MKR-INS-08 en
```

Expected: `missing=0` в обеих локалях.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents/src/documents/cabinet-shift-planning.ts
git commit -m "docs(legal): describe pallets and the reworked equipment screen in MKR-INS-08"
```

---

### Task 5: Контент MKR-INS-09

**Files:**

- Modify: `packages/legal-documents/src/documents/cabinet-shift-close.ts`

- [ ] **Step 1: §3 «Панель смены» — подраздел «Паллеты»**

Новый шаг с кадром `shift-pallets`. Цитаты: заголовок «Паллеты», колонки «SSCC», «Линия», «Коробов», «Кодов», «Закрыта», «Статус», пустое состояние «В этой смене нет паллет», отказ «Не удалось загрузить паллеты смены.». `definition-list` на три состояния — «Разобрана», «Без SSCC», «Состав изменился после закрытия» — термины без завершающей пунктуации.

Секция появляется только у смены, запланированной с паллетами: это сказать явно, иначе её отсутствие читается как сбой.

- [ ] **Step 2: §3 — ярлыки**

Шаг с кадром `pallet-placards`: кнопка «Ярлыки», окно «Ярлыки паллет смены», выбор формата. Условие печати описать дословно: страница печатается для каждой закрытой, неразобранной паллеты с SSCC — поэтому разобранная паллета и паллета без SSCC в печать не попадают.

- [ ] **Step 3: §7 «Отчёты для ГИС МТ» — каталог 5 → 10**

Перечислить пять новых форматов дословно: «[TXT][Паллеты] Отчет смены», «[CSV][Паллеты] Отчет смены», «[XML][ГИСМТ] Паллетная агрегация», «[TXT][Паллеты → короба] Отчет смены», «[XML][ГИСМТ] Агрегация паллет без кодов».

Добавить `definition-list` по паллетным отказам (ключи `pages.shifts.exports.errors.*`): «В смене нет закрытых паллет…», «Паллета ещё не закрыта — отчёт формируется только по закрытой паллете.», «Паллета разобрана — отчёт по ней больше не формируется.», «Паллета вместе со своими коробами не помещается в установленное ограничение строк.»

В английском тексте — оговорка, что каталог форматов ведётся на русском и кабинет показывает его как есть (справочник живёт в `packages/domain/src/shift-exports.ts` и одноязычен).

- [ ] **Step 4: Линза**

```bash
node /tmp/claude-501/lens.mjs /Users/thevladbog/PRSOME/q-audit MKR-INS-09 ru
node /tmp/claude-501/lens.mjs /Users/thevladbog/PRSOME/q-audit MKR-INS-09 en
```

Expected: `missing` содержит только ярлыки форматов отчётов (принятое исключение), больше ничего.

- [ ] **Step 5: Commit**

```bash
git add packages/legal-documents/src/documents/cabinet-shift-close.ts
git commit -m "docs(legal): describe shift pallets, placards and pallet reports in MKR-INS-09"
```

---

### Task 6: Ревизии, артефакты и аттестация

**Files:**

- Modify: `packages/legal-documents/src/registry.ts`, `packages/legal-documents/test/registry.test.ts`, `packages/legal-documents/test/artifact-manifest.test.ts`, `apps/landing/public/legal/`, `deploy/production/*`

- [ ] **Step 1: Реестр**

В `LEGAL_RELEASES` заменить у MKR-INS-08 `revision: "2026.09/01"` на `"2026.09/02"`, у MKR-INS-09 `"2026.09/03"` на `"2026.09/04"`; обеим записям выставить `effectiveDate` дня выпуска. Маршруты не трогать.

- [ ] **Step 2: Тесты реестра**

`registry.test.ts`: в матрице `reissuedRevision` обновить обе записи и дописать комментарий с причиной переиздания (паллеты и перерисованный экран оборудования); обновить `findLegalRelease("MKR-INS-08"/"MKR-INS-09").effectiveDate`.

- [ ] **Step 3: Манифестные тесты**

`artifact-manifest.test.ts`: в `artifactEntry` ветки ревизий и дат обновить оба кода; в списке ожидаемых запросов заменить четыре строки на новые ревизии и даты (формат `MKR-INS-08|ru|legal-pdf|https://markiro.app/d/MKR-INS-08/2026.09/02/<DD.MM.YYYY>`). Счётчики 34 / 30 НЕ меняются.

- [ ] **Step 4: Генерация**

```bash
cd /Users/thevladbog/PRSOME/q-audit
pnpm --filter @markiro/legal-documents build
rm -rf apps/landing/public/legal
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
git status --short apps/landing/public/legal
```

Expected: «Validated 34 immutable legal artifacts»; четыре старых имени удалены, четыре новых добавлены, `artifacts.json` изменён. Если изменился любой из 30 прочих PDF — STOP.

- [ ] **Step 5: Verify**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: «Verified 34 immutable legal artifacts». Без `SOFFICE_BIN` команда отказывается работать.

- [ ] **Step 6: Аттестация**

```bash
shasum -a 256 apps/landing/public/legal/artifacts.json
```

- `deploy/production/legal-artifacts-attestation.json`: `releaseId` → `MKR-LEGAL-2026.09-22-<дата>`, новый `manifestSha256`, четыре записи `pdfs` переименованы с новыми `sha256`, список отсортирован по имени файла.
- `deploy/production/verify-legal-artifacts.mjs`: константа `RELEASE_ID` и четыре имени в `EXPECTED_PDFS`.
- `deploy/production/test/legal-artifact-attestation.test.mjs`: собственные копии `releaseId`, `manifestSha256` и список `releasedPdfNames`. Счётчики 30 не меняются.

- [ ] **Step 7: Прогоны**

```bash
pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing test
node --test deploy/production/test/*.mjs
```

Expected: всё зелёное.

- [ ] **Step 8: Commit**

```bash
git add packages/legal-documents apps/landing/public/legal deploy/production
git commit -m "feat(legal): reissue MKR-INS-08 and MKR-INS-09 with pallets"
```

---

### Task 7: Гейты CI и финальная верификация

**Files:**

- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Завести кабинетные сьюты в CI**

В джобе, где уже запускаются `test:national-catalog`, `test:reports`, `test:offers`, `test:catalog-regulatory`, добавить `test:inventory`, `test:production` и `test:catalog-import`.

`test:catalog` НЕ добавлять: она красная из-за MKR-INS-10 (модель готовности карточки, отдельный цикл). Зафиксировать это в отчёте PR явно.

- [ ] **Step 2: Общие гейты**

```bash
cd /Users/thevladbog/PRSOME/q-audit
pnpm format:check
pnpm --filter @markiro/legal-documents lint
pnpm --filter @markiro/landing lint
cd tools/production-browser && pnpm exec tsc -p tsconfig.json --noEmit
```

- [ ] **Step 3: Сборка лендинга**

```bash
pnpm --filter @markiro/landing build
grep -c "mkr-ins-08_2026.09-02_ru.pdf" apps/landing/dist/legal/index.html
grep -c "mkr-ins-09_2026.09-04_ru.pdf" apps/landing/dist/legal/index.html
```

Expected: по `1` на каждый.

- [ ] **Step 4: Сверка релиза**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" \
  node packages/legal-documents/dist/cli/generate-artifacts.js --out-dir apps/landing/public/legal --check
git status --short
```

Expected: «Validated 34 immutable legal artifacts», дерево чистое.

- [ ] **Step 5: Просмотр PDF**

Растеризовать четыре новые редакции и просмотреть постранично: кадры на месте, подписи не обрезаны, таблица метаданных несёт новые ревизии.

```bash
for f in mkr-ins-08_2026.09-02_ru mkr-ins-08_2026.09-02_en mkr-ins-09_2026.09-04_ru mkr-ins-09_2026.09-04_en; do
  pdftoppm -r 72 -png "apps/landing/public/legal/files/markiro_$f.pdf" "$TMPDIR/$f"
done
```

- [ ] **Step 6: Отчёт**

В теле PR: таблица «цитата → ключ → кадр», список принятых исключений, перечень найденных расхождений продукта и явная запись о том, что `test:catalog` остаётся вне CI до цикла MKR-INS-10.
