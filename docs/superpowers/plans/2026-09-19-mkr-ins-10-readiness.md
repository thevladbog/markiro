# MKR-INS-10: переиздание под готовность и характеристики — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** переиздать MKR-INS-10 в обеих локалях так, чтобы он описывал модель готовности, категорию и характеристики товара.

**Architecture:** чиним оснастку съёмки (`catalog.visual.spec.ts` не знает двух новых эндпоинтов), снимаем новые кадры и пересматриваем старые, правим контент, двигаем ревизию, перевыпускаем два PDF и аттестацию, переносим линзу в репозиторий и заводим `test:catalog` в CI.

**Tech Stack:** Playwright (`--ignore-workspace`), харнесс кабинета `production.html`, `@markiro/legal-documents`, `@markiro/domain` (zod-схемы), LibreOffice + veraPDF.

**Рабочее место:** worktree `/Users/thevladbog/PRSOME/q/.claude/worktrees/instructions-catalog-readiness`, ветка `claude/instructions-catalog-readiness` от `origin/main` (`7bdeae65a`). Зависимости установлены, `dist` собран, `tools/production-browser` установлен с `--ignore-workspace`.

## Global Constraints

- Ревизия `2026.09/01 → 2026.09/02`, дата вступления — день выпуска.
- Релиз остаётся 34 файла / 30 PDF; два файла меняют имя, остальные 28 — байт-в-байт.
- Идентификаторы секций и кадров совпадают между локалями (`content-contract.test.ts`).
- В русском тексте «Маркиро», без латинского `Markiro`; в английском наоборот, и `—` вместо `--`.
- Термины `definition-list` не заканчиваются знаком препинания.
- Кадры кабинета снимаются на ширине 1280.
- **Фикстуры прогоняются через настоящие zod-схемы** из `packages/domain/dist` — `profileSchema`/`readinessSchema` парсят ответ на клиенте, поэтому выдуманная форма бросит исключение вместо тихой заглушки. Схемы уже экспортируются: `categorySchemaDefinitionSchema`, `productAttributeValueSchema`, `READINESS_DIMENSIONS`, `READINESS_STATES`, `PRODUCT_ATTRIBUTE_SOURCES`.
- Перед браузерными спеками: `pnpm --filter @markiro/platform-contracts build`.
- Playwright, docker и `gh` — только с `dangerouslyDisableSandbox: true`.
- **Зелёная сьюта не доказывает, что кадр верен.** После каждого прогона, переписывающего кадры, кадры открывать. В прошлом цикле так проскочили аварийная плашка, обрезанный текст и выдуманное состояние данных — всё при зелёных тестах.

## Контракты, от которых зависят фикстуры

`GET /products/:id/readiness` → `{ productId, dimensions: [{ dimension, state, reasons[], recommendations[] }] }`, где `dimension` ∈ `READINESS_DIMENSIONS`, `state` ∈ `READINESS_STATES` (`ready`/`not_ready`/`not_applicable`/`stale`), а `reasons`/`recommendations` — `{ code, attributeId?, triggerAttributeId?, schemaVersionId? }`.

`GET /products/:id/regulatory-profile` → `{ productId, binding, definition, values[], egaisCodes[], pendingProposalCount }`. `binding` — `{ revision, categoryId, categoryName, schemaVersionId (uuid), tnVedCode, okpd2Code, source, confirmedAt }` или `null`. `definition` — `{ formatVersion: 2, categoryId, scopeKey, attributes[] }`, где атрибут это `{ id, label, valueType, multiplicity, unit, requirementRules[], presetMode, presets[] }`; `requirementRules` — `{ layer: "code_ordering"|"circulation", level: "mandatory"|"recommended"|"optional", when }`. Оба объекта `.strict()`.

Коды причин готовности (`pages.catalog.regulatory.reasons.*`): `PRODUCTION_GROUP_REQUIRED`, `PRODUCTION_BOX_CAPACITY_REQUIRED`, `PRODUCTION_PALLET_CAPACITY_REQUIRED`, `CATEGORY_NOT_CONFIRMED`, `SCHEMA_VERSION_STALE`, `ATTRIBUTE_REQUIRED`, `ATTRIBUTE_RECOMMENDED`, `EGAIS_CODE_REQUIRED`, `EGAIS_CODE_INVALID`, `EGAIS_PRIMARY_REQUIRED`, `EGAIS_PRIMARY_INVALID`.

---

### Task 1: Фикстуры готовности и профиля

**Files:**

- Modify: `tools/production-browser/tests/catalog.visual.spec.ts`

**Interfaces:**

- Produces: `fx.READINESS`, `fx.REGULATORY_PROFILE`, маршруты `/products/:id/readiness` и `/products/:id/regulatory-profile` в `installApi`.

- [ ] **Step 1: Убедиться в поломке**

```bash
cd tools/production-browser && pnpm test:catalog 2>&1 | tail -5
```

Expected: десять упавших тестов; в `unexpected` строки `GET /api/products/<id>/readiness` и `.../regulatory-profile`.

- [ ] **Step 2: Импортировать схемы и построить фикстуры**

Импорт по образцу `catalog-import.visual.spec.ts`, который берёт схемы из `../../../packages/platform-contracts/dist/index.js`:

```ts
import { categorySchemaDefinitionSchema } from "../../../packages/domain/dist/index.js";
```

Внутри `fixtures(locale)` собрать определение категории и прогнать его через схему — набор должен показывать РАЗНЫЕ уровни обязательности, иначе кадр характеристик не покажет того, что описывает текст:

```ts
/**
 * Three attributes at three requirement levels, so the frame shows what the
 * document explains: one mandatory for code ordering, one mandatory for
 * circulation, one recommended. Parsed through the real schema -- the client
 * parses this response too, so an invented shape throws here instead of
 * rendering an empty block.
 */
const CATEGORY_DEFINITION = categorySchemaDefinitionSchema.parse({
  formatVersion: 2,
  categoryId: "cat-syrup",
  scopeKey: "national_catalog",
  attributes: [
    {
      id: "volume",
      label: copy.attrVolume,
      valueType: "decimal",
      multiplicity: "one",
      unit: { canonical: "л", allowed: ["л", "мл"] },
      requirementRules: [{ layer: "code_ordering", level: "mandatory", when: null }],
      presetMode: "none",
      presets: [],
    },
    {
      id: "composition",
      label: copy.attrComposition,
      valueType: "string",
      multiplicity: "one",
      unit: null,
      requirementRules: [{ layer: "circulation", level: "mandatory", when: null }],
      presetMode: "none",
      presets: [],
    },
    {
      id: "package",
      label: copy.attrPackage,
      valueType: "enum",
      multiplicity: "one",
      unit: null,
      requirementRules: [{ layer: "circulation", level: "recommended", when: null }],
      presetMode: "suggested",
      presets: [{ value: "glass", label: copy.attrPackageGlass }],
    },
  ],
});
```

Профиль и готовность — рядом. Готовность должна нести разные состояния, иначе панель покажет четыре одинаковых строки:

```ts
const REGULATORY_PROFILE = {
  productId: PRODUCT_ID,
  binding: {
    revision: 3,
    categoryId: "cat-syrup",
    categoryName: copy.categoryName,
    schemaVersionId: "40000000-0000-4000-8000-000000000001",
    tnVedCode: "2106909200",
    okpd2Code: "10.89.19.190",
    source: "national_catalog" as const,
    confirmedAt: "2026-09-15T08:30:00.000Z",
  },
  definition: CATEGORY_DEFINITION,
  values: [
    {
      entryId: "50000000-0000-4000-8000-000000000001",
      attributeId: "volume",
      value: { type: "decimal" as const, value: "0.5", unit: "л" },
      source: "national_catalog" as const,
      observedAt: "2026-09-15T08:00:00.000Z",
      appliedAt: "2026-09-15T08:30:00.000Z",
    },
  ],
  egaisCodes: [],
  pendingProposalCount: 0,
};

/**
 * What `evaluateProductReadiness` returns for the attribute data above.
 * Three of the four states is the most one frame can carry: `stale` only
 * comes from a regulatory dimension, both regulatory dimensions branch on the
 * single shared `input.schemaStale`, and that branch returns no
 * recommendations.
 */
const READINESS = {
  productId: PRODUCT_ID,
  dimensions: [
    { dimension: "production" as const, state: "ready" as const, reasons: [], recommendations: [] },
    {
      dimension: "code_ordering" as const,
      state: "ready" as const,
      reasons: [],
      recommendations: [],
    },
    {
      dimension: "circulation" as const,
      state: "not_ready" as const,
      reasons: [
        {
          code: "ATTRIBUTE_REQUIRED",
          attributeId: "composition",
          schemaVersionId: "40000000-0000-4000-8000-000000000001",
        },
      ],
      recommendations: [
        {
          code: "ATTRIBUTE_RECOMMENDED",
          attributeId: "package",
          schemaVersionId: "40000000-0000-4000-8000-000000000001",
        },
      ],
    },
    {
      dimension: "egais" as const,
      state: "not_applicable" as const,
      reasons: [],
      recommendations: [],
    },
  ],
};
```

Первая редакция этой фикстуры была сверена с текстом документа, но не с
`packages/domain/src/product-attributes/readiness.ts`, и описывала экран,
который продукт выдать не может: два регулятивных измерения ветвятся по
одному `input.schemaStale`, ветка `stale` не возвращает рекомендаций, а
`activeRequirementRules` фильтрует правила строго по слою, поэтому правило
`circulation` не может всплыть под «Заказом кодов». Любую фикстуру
готовности сверять с вычислителем, а не с текстом.

`productAttributeValueSchema` — дискриминированное по `type` объединение `.strict()`; вариант `decimal` это `{ type: "decimal", value: "<строка-число>", unit: string | null }`. Другие варианты: `string`, `string_list`, `boolean`, `date`, `enum`, `enum_list`.

Добавить обе фикстуры в возвращаемый объект `fixtures()`.

- [ ] **Step 3: Маршруты**

В `installApi`, до `unexpected.push`:

```ts
if (path.endsWith("/readiness")) return json(route, fx.READINESS);
if (path.endsWith("/regulatory-profile")) return json(route, fx.REGULATORY_PROFILE);
```

Если карточка запрашивает их и для черновика/архивного товара, отвечать тем же — иначе строгий перехват свалит тесты.

- [ ] **Step 4: Прогон**

```bash
cd tools/production-browser && pnpm test:catalog 2>&1 | tail -5
```

Expected: 22 теста PASS, `unexpected` пуст.

- [ ] **Step 5: Commit**

```bash
git add tools/production-browser/tests/catalog.visual.spec.ts
git commit -m "test(catalog): teach the product card suite about readiness and attributes"
```

Кадры, переписанные этим прогоном, НЕ коммитить — их разбирает Task 3.

---

### Task 2: Новые кадры

**Files:**

- Modify: `tools/production-browser/tests/catalog.visual.spec.ts`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-10/{ru,en}/product-readiness.png`
- Create: `.../{ru,en}/product-category.png`
- Create: `.../{ru,en}/product-attributes.png`

- [ ] **Step 1: Как адресуются блоки**

Снимать сами секции, а не страницу: карточка очень высокая, и полностраничный кадр трижды повторил бы одно и то же.

Помощник в файле уже готов — `screenshotSection(page, sectionId, path)` ищет `section[aria-labelledby="${sectionId}"]`, а регуляторные блоки размечены ровно так:
`product-readiness-title` (`ReadinessPanel.tsx:23`), `category-binding-title` (`CategoryBinding.tsx:129`), `category-attributes-title` (`CategoryAttributesForm.tsx:133`). Менять помощник не нужно.

- [ ] **Step 2: Три теста**

По образцу соседних тестов в файле; селекторы — только через `t("…")`:

```ts
test(`[${locale}] the card reports readiness per operation`, async ({ page }) => {
  const unexpected = await installApi(page, "productActive");
  await openHarness(page, locale, `/catalog/${PRODUCT_ID}/edit`);
  await expect(
    page.getByRole("heading", { name: t("pages.catalog.regulatory.readiness") }),
  ).toBeVisible();
  await expect(
    page.getByText(t("pages.catalog.regulatory.states.ready"), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(t("pages.catalog.regulatory.states.not_applicable"), { exact: true }),
  ).toBeVisible();
  await screenshotSection(page, "product-readiness-title", shot("product-readiness"));
  expect(unexpected).toEqual([]);
});
```

Аналогично `product-category` (заголовок `pages.catalog.regulatory.category`, видимы «ТН ВЭД» и «ОКПД2») и `product-attributes` (заголовок `pages.catalog.regulatory.attributes`, видимы пометки «Обязательно для заказа кодов» и «Рекомендуется»).

- [ ] **Step 3: Прогон и просмотр**

```bash
cd tools/production-browser && pnpm test:catalog 2>&1 | tail -5
```

Expected: 28 тестов PASS. Открыть все шесть новых PNG. Убедиться: на `product-readiness` видны четыре измерения и минимум три разных состояния; на `product-attributes` видны разные пометки обязательности, а не одинаковые; на `product-category` заполнены название категории, ТН ВЭД и ОКПД2.

- [ ] **Step 4: Commit**

Коммитить ТОЛЬКО шесть новых кадров поимённо — прочие, переписанные прогоном, разбирает Task 3.

```bash
git add tools/production-browser/tests/catalog.visual.spec.ts \
        packages/legal-documents/assets/instructions/mkr-ins-10/ru/product-readiness.png \
        packages/legal-documents/assets/instructions/mkr-ins-10/en/product-readiness.png \
        packages/legal-documents/assets/instructions/mkr-ins-10/ru/product-category.png \
        packages/legal-documents/assets/instructions/mkr-ins-10/en/product-category.png \
        packages/legal-documents/assets/instructions/mkr-ins-10/ru/product-attributes.png \
        packages/legal-documents/assets/instructions/mkr-ins-10/en/product-attributes.png
git commit -m "test(catalog): capture the readiness, category and attribute frames"
```

---

### Task 3: Пересъёмка и разбор дрейфа

- [ ] **Step 1: Отделить дрейф от изменения**

```bash
git status --short packages/legal-documents/assets | awk '{print $2}' | while IFS= read -r f; do
  git show "HEAD:$f" > /tmp/claude-501/base.png
  v=$(magick compare -metric PAE /tmp/claude-501/base.png "$f" null: 2>&1 | grep -oE '^[0-9]+')
  d1=$(magick identify -format "%wx%h" /tmp/claude-501/base.png)
  d2=$(magick identify -format "%wx%h" "$f")
  printf "%-60s PAE=%-7s %s -> %s\n" "${f#packages/legal-documents/assets/instructions/}" "$v" "$d1" "$d2"
done
```

PAE < 5000 при неизменившихся размерах — субпиксельный дрейф, откатить через `git checkout --`. Всё остальное — настоящее изменение: оставить и просмотреть.

- [ ] **Step 2: Просмотр**

Открыть каждый оставшийся кадр и записать, что изменилось: этот список Task 4 превращает в правки текста. По аудиту ожидаются изменения в `catalog-list`, `catalog-filters`, `candidates-plaque`, `catalog-delete`, `product-new`, `product-gtin-owner`, `product-draft-banner`, `product-archived`.

- [ ] **Step 3: Commit**

```bash
git add packages/legal-documents/assets/instructions/mkr-ins-10
git commit -m "test(catalog): reshoot the product card frames against the current cabinet"
```

---

### Task 4: Контент

**Files:**

- Modify: `packages/legal-documents/src/documents/cabinet-catalog-product.ts`

Нынешние разделы: `purpose`, `list`, `create`, `activate`, `image`, `defaults`, `retire`, `external`, `troubleshooting`.

- [ ] **Step 1: Новый раздел «Готовность к операциям»**

Вставить после `activate`, идентификатор `readiness`. Содержание:

- Разведение двух понятий. Статус карточки («Активен», «Черновик») отвечает за запуск смены; готовность проверяется отдельно по четырём операциям. Товар может быть активен и при этом не готов к вводу в оборот. Цитата продукта: «Готовность проверяется по сохранённым данным Markiro отдельно для каждой операции.»
- Шаг с кадром `product-readiness`: четыре измерения — «Производство», «Заказ кодов», «Ввод в оборот», «ЕГАИС» — и четыре состояния: «Готово», «Не готово», «Нужна актуализация», «Не применяется».
- `definition-list` по классам причин, не по всем одиннадцати кодам: не выбрана товарная группа, не указано количество в коробе или на паллете, не подтверждена категория, доступна новая схема категории, не заполнены характеристики, не хватает кодов ЕГАИС. Термины без завершающей пунктуации.

- [ ] **Step 2: Новый раздел «Категория и характеристики»**

Идентификатор `category`, после `readiness`. Содержание:

- Шаг с кадром `product-category`: привязка к категории Национального каталога, «Выбрать категорию», «Подтвердить категорию», флажок «Подтверждаю, что категория подходит выбранной товарной группе ЧЗ.», поля «ТН ВЭД» и «ОКПД2», «Источник».
- Смена категории: «Сменить категорию» → «Проверить изменения» → «Проверьте перенос значений», три исхода из `pages.catalog.regulatory.dispositions` и подсказка «Отмеченные значения перейдут в новую категорию…».
- Шаг с кадром `product-attributes`: пометки «Обязательно для заказа кодов», «Обязательно для ввода в оборот», «Рекомендуется», «Дополнительно»; «Не указано» для пустого значения; «Сохранить характеристики».
- Подраздел про коды ЕГАИС («Коды АП ЕГАИС», «Добавить код АП ЕГАИС», «Основной код АП ЕГАИС») с оговоркой, что блок появляется только для товарных групп, к которым алкоголь применим. Проверить условие по `isEgaisApplicable` в `ProductRegulatorySections.tsx` и описать его словами, не выдумывая список групп.
- `callout` про порядок работы, дословно: «Сначала сохраните основные данные товара, затем изменяйте категорию и характеристики.»
- Ссылка на панель связи: «Национальный каталог» ведёт в раздел, описанный отдельной инструкцией по загрузке из Национального каталога. Не дублировать её содержание.

- [ ] **Step 3: Правки в существующих разделах**

- §3 и §4: заменить «Вместимость поддона, шт» на «Коробов на паллете» — поле переименовано продуктом. Проверить оба вхождения линзой.
- §9: в ответе про столбец «Честный знак» добавить, что готовность и связь с карточкой ЧЗ — разные вещи.
- Прочие расхождения, найденные в Task 3, поправить здесь же.

- [ ] **Step 4: Линза**

```bash
pnpm --filter @markiro/legal-documents build
node /tmp/claude-501/lens.mjs "$PWD" MKR-INS-10 ru
node /tmp/claude-501/lens.mjs "$PWD" MKR-INS-10 en
```

Expected: `missing=0` в обеих локалях.

- [ ] **Step 5: Прогон и commit**

```bash
pnpm --filter @markiro/legal-documents test
pnpm exec prettier --check packages/legal-documents/src/documents/cabinet-catalog-product.ts
git add packages/legal-documents/src/documents/cabinet-catalog-product.ts
git commit -m "docs(legal): describe readiness, category and attributes in MKR-INS-10"
```

Expected: падают только манифестные тесты, ждущие новой ревизии.

---

### Task 5: Линза в репозиторий

**Files:**

- Create: `tools/instruction-lens/lens.mjs`, `tools/instruction-lens/lens.test.mjs`, `tools/instruction-lens/README.md`

Инструмент два цикла подряд находил настоящие расхождения и живёт в `/tmp`. Исходник — `/tmp/claude-501/lens.mjs`.

- [ ] **Step 1: Перенести**

Скопировать, оформить как обычный модуль репозитория: пути к словарям и к `dist` брать относительно корня, аргументы те же (`<root> <CODE> <ru|en> [dictDir]`).

- [ ] **Step 2: Тест на оба прежних дефекта**

`node --test`, без внешних зависимостей. Два случая обязательны, потому что оба были настоящими:

1. Словарь со значением `"{{name}}"` (голый плейсхолдер) не должен засчитывать произвольную цитату. До починки он компилировался в `^.+$` и глушил проверку целиком.
2. Словарь со значением `"{{count}} смены"` не должен засчитывать цитату «[TXT][Паллеты] Отчет смены». До починки короткий литерал давал `^.+ смены$`.

Плюс положительные случаи: точное совпадение, префикс, настоящий шаблон («Выбрано: {{count}} из 100» ↔ «Выбрано: 0 из 100»), фрагмент из середины строки.

- [ ] **Step 3: README**

Что инструмент проверяет, как запускать, какие классы вердиктов бывают и какие исключения приняты в серии (сырые статусы ЧЗ, одноязычный справочник форматов отчётов, серверная русская форма-задание, составные строки).

- [ ] **Step 4: Прогон и commit**

```bash
node --test tools/instruction-lens/lens.test.mjs
pnpm exec prettier --check tools/instruction-lens
git add tools/instruction-lens
git commit -m "tools: move the instruction quote lens into the repository"
```

---

### Task 6: Ревизия, артефакты и аттестация

**Files:**

- Modify: `packages/legal-documents/src/registry.ts`, `test/registry.test.ts`, `test/artifact-manifest.test.ts`, `apps/landing/public/legal/`, `deploy/production/*`

- [ ] **Step 1: Реестр**

У записи MKR-INS-10 заменить `revision: "2026.09/01"` на `"2026.09/02"`, `effectiveDate` — день выпуска. Маршруты не трогать.

- [ ] **Step 2: Тесты реестра и манифеста**

`registry.test.ts`: обновить матрицу `reissuedRevision` с комментарием о причине (модель готовности и характеристики категории) и `findLegalRelease("MKR-INS-10").effectiveDate`.

`artifact-manifest.test.ts`: ветки ревизий и дат для кода, строки ожидаемых запросов для обеих локалей в формате `MKR-INS-10|ru|legal-pdf|https://markiro.app/d/MKR-INS-10/2026.09/02/<DD.MM.YYYY>`. Счётчики 34 / 30 НЕ меняются.

- [ ] **Step 3: Генерация и проверка**

```bash
pnpm --filter @markiro/legal-documents build
rm -rf apps/landing/public/legal
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
git status --short apps/landing/public/legal
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
shasum -a 256 apps/landing/public/legal/artifacts.json
```

Expected: «Validated 34», затем «Verified 34». Ровно два удаления, два добавления и `artifacts.json`. Если изменился любой из 28 прочих PDF — STOP.

- [ ] **Step 4: Аттестация № 23**

`releaseId` → `MKR-LEGAL-2026.09-23-<дата>`. Обновить **все четыре** места: JSON аттестации (новый `manifestSha256`, две переименованные записи в `pdfs`, список отсортирован по имени), `RELEASE_ID` и `EXPECTED_PDFS` в `deploy/production/verify-legal-artifacts.mjs`, и независимые копии `releaseId`, `manifestSha256` и `releasedPdfNames` в `deploy/production/test/legal-artifact-attestation.test.mjs`.

- [ ] **Step 5: Прогоны**

```bash
pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing test
node --test deploy/production/test/*.mjs
pnpm test:production-bundle:contract
```

Expected: всё зелёное.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents apps/landing/public/legal deploy/production
git commit -m "feat(legal): reissue MKR-INS-10 with readiness and category attributes"
```

---

### Task 7: CI и финальная верификация

- [ ] **Step 1: Завести `test:catalog` в CI**

В `.github/workflows/ci.yml`, рядом с шагами «Verify the shift instruction frames» и «Verify the National Catalog import frames», добавить шаг для `test:catalog` и выгрузку доказательств. **Путь выгрузки брать из `outputDir` в `tools/production-browser/catalog.playwright.config.ts`**, а не копировать у соседа: в прошлом цикле скопированный путь указывал в несуществующий каталог и молча ничего не выгружал.

- [ ] **Step 2: Проверить бюджет джоба**

`production-bundle` уже поднят до 40 минут после прошлого цикла. Прикинуть стоимость шага по локальному прогону и, если запас меньше двух минут, поднять лимит в том же коммите с указанием измеренной цифры.

- [ ] **Step 3: Общие гейты**

```bash
pnpm format:check
pnpm --filter @markiro/legal-documents lint
pnpm --filter @markiro/landing lint
cd tools/production-browser && pnpm exec tsc -p tsconfig.json --noEmit
```

- [ ] **Step 4: Сборка лендинга**

```bash
pnpm --filter @markiro/landing build
grep -c "mkr-ins-10_2026.09-02_ru.pdf" apps/landing/dist/legal/index.html
```

Expected: `1`.

- [ ] **Step 5: Сверка релиза**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" \
  node packages/legal-documents/dist/cli/generate-artifacts.js --out-dir apps/landing/public/legal --check
git status --short
```

Expected: «Validated 34 immutable legal artifacts», дерево чистое.

- [ ] **Step 6: Просмотр PDF**

```bash
for f in mkr-ins-10_2026.09-02_ru mkr-ins-10_2026.09-02_en; do
  pdftoppm -r 72 -png "apps/landing/public/legal/files/markiro_$f.pdf" "/tmp/claude-501/$f"
done
```

Пройти постранично: метаданные несут новую ревизию и дату, три новых кадра на месте и читаемы, подписи не обрезаны, ни одна страница не пуста.

- [ ] **Step 7: Отчёт**

В теле PR: таблица «цитата → ключ → кадр», принятые исключения, найденные расхождения продукта и состояние гейтов — с указанием, что теперь под присмотром все четыре кабинетные кадровые сьюты.
