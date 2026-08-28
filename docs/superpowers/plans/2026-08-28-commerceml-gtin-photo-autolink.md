# CommerceML: GTIN, автосвязь и фото товара — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Импорт CommerceML начинает читать `<Штрихкод>` (GTIN) и `<Картинка>`, автоматически связывает позиции с карточками по GTIN и перекачивает фото товара; цена работает как раньше.

**Architecture:** Всё внутри существующего канала `commerceml` (спека `docs/superpowers/specs/2026-08-28-commerceml-gtin-photo-autolink-design.md`). Парсер (`parse.ts`) аддитивно отдаёт штрихкод/картинки; чистая функция `decideApplication` (`apply.ts`) принимает ВСЕ карточки тенанта (id, gtin14, externalRef) и планирует четыре вида работ: `link` → `price` → `image` → `candidate`; контроллер пишет их батчами под существующим курсором с fingerprint. Фото применяется через существующий media-пайплайн (`processProductImage` → staging → active) новым методом `ProductsService.applyExchangeImage` с машинным актором (`actorUserId: null`) и дедупом по checksum. URL-картинки качает новый модуль `image-download.ts` (только https, DNS-guard от SSRF, 5 МБ, 10 с, 3 редиректа).

**Tech Stack:** NestJS, Drizzle (Postgres), fast-xml-parser, sharp (в worker), vitest + supertest, `@markiro/domain` (`normalizeToGtin14`/`isValidGtin` уже существуют — новый GTIN-код НЕ пишем).

## Global Constraints

- Язык комментариев/журнала — как в соседнем коде (журнал — русский, читает 1С-специалист).
- Правило маршрута: «одна плохая позиция — skip + журнал, не упавший раунд»; ответ на wire всегда 200/plain text.
- Цена по-прежнему трогает ТОЛЬКО `unit_price`; link — только `external_ref`; image — только фото. Имя/GTIN карточки из обмена не пишутся никогда.
- `products.gtin14` — `char(14)`, `^[0-9]{14}$`, уникален по `(tenant_id, gtin14)`.
- Автосоздание карточек из обмена запрещено (кандидаты — единственный путь).
- Пакеты: `@markiro/api`, `@markiro/db`, `@markiro/admin`, `@markiro/domain`. Тесты: `pnpm --filter <pkg> test -- <substring>`.
- Коммиты заканчивать `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Парсер — `<Штрихкод>` и `<Картинка>`

**Files:**

- Modify: `apps/api/src/modules/exchange/commerceml/parse.ts`
- Test: `apps/api/test/commerceml-parse.test.ts`

**Interfaces:**

- Consumes: существующие `parseCatalog`/`parseOffers`/`parseCommerceMl`.
- Produces: `ParsedItem` получает `barcode: string | null` и `images: string[]`; `ParsedOffer` получает `barcode: string | null`. Task 2 читает оба.

- [ ] **Step 1: Failing-тесты**

Добавить в `apps/api/test/commerceml-parse.test.ts` (стиль файла — обычные vitest-тесты над `Buffer.from(xml)`):

```ts
describe("штрихкод и картинка", () => {
  it("читает Штрихкод и повторяющиеся Картинка у товара", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация>
 <Каталог><Товары>
  <Товар>
   <Ид>guid-1</Ид><Наименование>Сидр</Наименование>
   <Штрихкод>4680089900253</Штрихкод>
   <Картинка>import_files/a.png</Картинка>
   <Картинка>import_files/b.png</Картинка>
  </Товар>
 </Товары></Каталог>
</КоммерческаяИнформация>`;
    const { items } = parseCatalog(Buffer.from(xml));
    expect(items[0]!.barcode).toBe("4680089900253");
    expect(items[0]!.images).toEqual(["import_files/a.png", "import_files/b.png"]);
  });

  it("без тегов — barcode null и пустой images", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация><Каталог><Товары>
  <Товар><Ид>guid-1</Ид><Наименование>Сидр</Наименование></Товар>
</Товары></Каталог></КоммерческаяИнформация>`;
    const { items } = parseCatalog(Buffer.from(xml));
    expect(items[0]!.barcode).toBeNull();
    expect(items[0]!.images).toEqual([]);
  });

  it("читает Штрихкод предложения", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация><ПакетПредложений><Предложения>
  <Предложение><Ид>guid-1</Ид><Штрихкод>4680089900253</Штрихкод></Предложение>
</Предложения></ПакетПредложений></КоммерческаяИнформация>`;
    const { offers } = parseOffers(Buffer.from(xml));
    expect(offers[0]!.barcode).toBe("4680089900253");
  });
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `pnpm --filter @markiro/api test -- commerceml-parse`
Expected: FAIL — `barcode`/`images` нет в типах/результате.

- [ ] **Step 3: Реализация**

В `parse.ts`:

1. `REPEATING_TAGS` — добавить `"Картинка"` (тег повторяется; без этого одиночная картинка придёт объектом, а не массивом).
2. `ParsedItem` — добавить поля с doc-комментарием, что `<Штрихкод>` читается как ОДИНОЧНЫЙ тег (CommerceML 2.05); файл с несколькими даст массив → `textOf` вернёт `""` → `null`, осознанная деградация «штрихкода нет»:

```ts
export interface ParsedItem {
  externalRef: string;
  name: string;
  article: string | null;
  unit: string | null;
  barcode: string | null;
  images: string[];
}
```

3. В `catalogItemsFrom` маппинг:

```ts
const rawImages = item["Картинка"];
return {
  externalRef: textOf(item["Ид"]),
  name: textOf(item["Наименование"]),
  article: optionalTextOf(item["Артикул"]),
  unit: optionalTextOf(item["БазоваяЕдиница"]),
  barcode: optionalTextOf(item["Штрихкод"]),
  images: (Array.isArray(rawImages) ? rawImages : [])
    .map((raw) => textOf(raw))
    .filter((value) => value !== ""),
};
```

4. `ParsedOffer` — добавить `barcode: string | null`; в `offersFrom` вернуть `barcode: optionalTextOf(offer["Штрихкод"])`.

- [ ] **Step 4: Тесты зелёные**

Run: `pnpm --filter @markiro/api test -- commerceml-parse`
Expected: PASS (включая старые тесты).

- [ ] **Step 5: Чинить компиляцию соседей**

`apply.ts`-тесты и контроллер строят `ParsedItem`/`ParsedOffer` литералами — typecheck упадёт на новых обязательных полях. Прогнать `pnpm --filter @markiro/api typecheck`; в местах-литералах добавить `barcode: null, images: []` (тестовые фикстуры). Логика apply меняется в Task 2, здесь — только компиляция.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/exchange/commerceml/parse.ts apps/api/test/commerceml-parse.test.ts apps/api/test/commerceml-apply.test.ts
git commit -m "feat(exchange): парсер CommerceML читает Штрихкод и Картинка"
```

---

### Task 2: apply.ts — GTIN-нормализация и решения об автосвязи/фото

**Files:**

- Modify: `apps/api/src/modules/exchange/commerceml/apply.ts`
- Test: `apps/api/test/commerceml-apply.test.ts`

**Interfaces:**

- Consumes: `ParsedItem.barcode/images`, `ParsedOffer.barcode` (Task 1); `isValidGtin`, `normalizeToGtin14` из `@markiro/domain`.
- Produces (для Task 6):

```ts
export interface CatalogProduct {
  id: string;
  gtin14: string;
  externalRef: string | null;
}
export interface AutoLink {
  productId: string;
  externalRef: string;
  gtin: string;
}
export interface ImageWork {
  productId: string;
  source: string;
}
export interface CandidateItem {
  externalRef: string;
  name: string;
  article: string | null;
  unit: string | null;
  gtin: string | null;
}
export interface GtinConflict {
  externalRef: string;
  gtin: string;
  productId: string;
  productExternalRef: string;
}
export interface GtinAmbiguity {
  gtin: string;
  externalRefs: string[];
}
export interface ApplicationPlan {
  links: AutoLink[];
  priceUpdates: PriceUpdate[];
  images: ImageWork[];
  candidates: CandidateItem[];
  skipped: SkippedOffer[];
  gtinConflicts: GtinConflict[];
  gtinAmbiguities: GtinAmbiguity[];
  invalidBarcodes: number;
}
export interface DecideApplicationInput {
  products: CatalogProduct[]; // ВСЕ карточки тенанта, не только связанные
  items: ParsedItem[];
  offers: ParsedOffer[];
  configuredPriceType?: string | undefined;
}
```

Тип `KnownProduct` удаляется (его роль забирает `CatalogProduct`).

- [ ] **Step 1: Failing-тесты**

В `apps/api/test/commerceml-apply.test.ts` (хелпер: `const product = (id: string, gtin14: string, externalRef: string | null) => ({ id, gtin14, externalRef });` и item-фикстуры с `barcode`/`images`):

```ts
describe("автосвязь по GTIN", () => {
  const item = (externalRef: string, barcode: string | null, images: string[] = []) => ({
    externalRef,
    name: "Товар",
    article: null,
    unit: null,
    barcode,
    images,
  });

  it("связывает несвязанную карточку по EAN-13 и применяет цену этим же раундом", () => {
    const plan = decideApplication({
      products: [product("p1", "04680089900253", null)],
      items: [item("ref-1", "4680089900253")],
      offers: [
        {
          externalRef: "ref-1",
          barcode: null,
          prices: [{ type: "Базовая", value: "9200.00", currency: "руб" }],
        },
      ],
    });
    expect(plan.links).toEqual([{ productId: "p1", externalRef: "ref-1", gtin: "04680089900253" }]);
    expect(plan.priceUpdates).toEqual([{ productId: "p1", unitPrice: "9200.00" }]);
    expect(plan.candidates).toEqual([]);
  });

  it("карточка связана с другим Ид — конфликт, позиция в кандидаты с GTIN", () => {
    const plan = decideApplication({
      products: [product("p1", "04680089900253", "other-ref")],
      items: [item("ref-1", "4680089900253")],
      offers: [],
    });
    expect(plan.links).toEqual([]);
    expect(plan.gtinConflicts).toEqual([
      {
        externalRef: "ref-1",
        gtin: "04680089900253",
        productId: "p1",
        productExternalRef: "other-ref",
      },
    ]);
    expect(plan.candidates[0]).toMatchObject({ externalRef: "ref-1", gtin: "04680089900253" });
  });

  it("две позиции файла с одним GTIN — не угадываем: обе в кандидаты", () => {
    const plan = decideApplication({
      products: [product("p1", "04680089900253", null)],
      items: [item("ref-1", "4680089900253"), item("ref-2", "4680089900253")],
      offers: [],
    });
    expect(plan.links).toEqual([]);
    expect(plan.gtinAmbiguities).toEqual([
      { gtin: "04680089900253", externalRefs: ["ref-1", "ref-2"] },
    ]);
    expect(plan.candidates).toHaveLength(2);
  });

  it("невалидный штрихкод считается и не рушит кандидата", () => {
    const plan = decideApplication({
      products: [],
      items: [item("ref-1", "4680089900250")],
      offers: [], // не сошлась контрольная
    });
    expect(plan.invalidBarcodes).toBe(1);
    expect(plan.candidates[0]).toMatchObject({ externalRef: "ref-1", gtin: null });
  });

  it("штрихкод берётся из предложения, когда у товара его нет", () => {
    const plan = decideApplication({
      products: [product("p1", "04680089900253", null)],
      items: [item("ref-1", null)],
      offers: [{ externalRef: "ref-1", barcode: "4680089900253", prices: [] }],
    });
    expect(plan.links).toHaveLength(1);
  });

  it("фото планируется для давно связанных и только что связанных", () => {
    const plan = decideApplication({
      products: [product("p1", "04680089900253", null), product("p2", "00000000000017", "ref-2")],
      items: [
        item("ref-1", "4680089900253", ["import_files/a.png"]),
        item("ref-2", null, ["https://disk.sbis.ru/x"]),
        item("ref-3", null, ["import_files/c.png"]), // не связан — фото некуда
      ],
      offers: [],
    });
    expect(plan.images).toEqual([
      { productId: "p1", source: "import_files/a.png" },
      { productId: "p2", source: "https://disk.sbis.ru/x" },
    ]);
  });
});
```

(GTIN `00000000000017`: тело `…001` + контрольная 7 — валидный; при сомнении посчитать `isValidGtin` в REPL.)

- [ ] **Step 2: Убедиться, что падают**

Run: `pnpm --filter @markiro/api test -- commerceml-apply`
Expected: FAIL — нет `products`/`links` в типах.

- [ ] **Step 3: Реализация**

В `apply.ts`:

1. Импорт: `import { isValidGtin, normalizeToGtin14 } from "@markiro/domain";` и приватный хелпер:

```ts
/**
 * `null` вместо исключения: для обмена невалидный штрихкод — «штрихкода
 * нет», а не ошибка файла (одна кривая позиция не рушит раунд). Проверка
 * длины (8/12/13/14) и контрольной цифры — целиком в @markiro/domain,
 * второй GTIN-валидатор в кодовой базе не заводится.
 */
function normalizeGtinOrNull(raw: string): string | null {
  const digits = raw.trim();
  return isValidGtin(digits) ? normalizeToGtin14(digits) : null;
}
```

2. Удалить `KnownProduct`, добавить типы из блока Interfaces выше.
3. Новый `decideApplication` (существующая цено-логика — `choosePrice`, `isHomeCurrency`, `normalizeUnitPriceValue` — НЕ меняется, меняется только откуда берётся карта «ref → товар»):

```ts
export function decideApplication(input: DecideApplicationInput): ApplicationPlan {
  const { products, items, offers, configuredPriceType } = input;

  const knownByRef = new Map<string, CatalogProduct>();
  for (const product of products) {
    if (product.externalRef !== null) knownByRef.set(product.externalRef, product);
  }
  const productsByGtin = new Map(products.map((p) => [p.gtin14, p]));

  // Штрихкод предложения — запасной источник: некоторые конфигурации кладут
  // его только в offers-файл. Первый выигрывает — как и везде в этом файле.
  const offerBarcodeByRef = new Map<string, string>();
  for (const offer of offers) {
    if (offer.barcode !== null && !offerBarcodeByRef.has(offer.externalRef)) {
      offerBarcodeByRef.set(offer.externalRef, offer.barcode);
    }
  }

  // GTIN считается только для НЕсвязанных позиций: у связанных он ничего не
  // решает (связь уже есть), а его расхождение с карточкой — вне среза.
  let invalidBarcodes = 0;
  const gtinByRef = new Map<string, string>();
  const unmatchedItems = items.filter((item) => !knownByRef.has(item.externalRef));
  for (const item of unmatchedItems) {
    const raw = item.barcode ?? offerBarcodeByRef.get(item.externalRef) ?? null;
    if (raw === null) continue;
    const gtin = normalizeGtinOrNull(raw);
    if (gtin === null) {
      invalidBarcodes++;
      continue;
    }
    gtinByRef.set(item.externalRef, gtin);
  }

  // Претенденты по каждому GTIN, у которого ЕСТЬ карточка. Двое и больше —
  // не угадываем (та же дисциплина, что ambiguous_price_type): все в
  // кандидаты, а факт — в журнал. GTIN без карточки в это вообще не входит:
  // там нечего связывать, дубль в файле — просто два кандидата.
  const claimants = new Map<string, string[]>();
  for (const [ref, gtin] of gtinByRef) {
    if (!productsByGtin.has(gtin)) continue;
    const list = claimants.get(gtin) ?? [];
    list.push(ref);
    claimants.set(gtin, list);
  }

  const links: AutoLink[] = [];
  const gtinConflicts: GtinConflict[] = [];
  const gtinAmbiguities: GtinAmbiguity[] = [];
  const linkedByRef = new Map<string, CatalogProduct>();
  for (const [gtin, refs] of claimants) {
    if (refs.length > 1) {
      gtinAmbiguities.push({ gtin, externalRefs: refs });
      continue;
    }
    const ref = refs[0]!;
    const product = productsByGtin.get(gtin)!;
    if (product.externalRef !== null) {
      // Карточка уже связана с ДРУГИМ <Ид> (с этим же — была бы в knownByRef,
      // и позиция не попала бы в unmatchedItems). Решает человек.
      gtinConflicts.push({
        externalRef: ref,
        gtin,
        productId: product.id,
        productExternalRef: product.externalRef,
      });
      continue;
    }
    links.push({ productId: product.id, externalRef: ref, gtin });
    linkedByRef.set(ref, product);
  }

  // Цены: давно связанные ПЛЮС связанные этим же раундом — «связь раньше
  // цены» из спеки §8 начинается уже здесь, в плане.
  const priceTargetByRef = new Map([...knownByRef, ...linkedByRef]);

  const priceUpdates: PriceUpdate[] = [];
  const skipped: SkippedOffer[] = [];
  for (const offer of offers) {
    const product = priceTargetByRef.get(offer.externalRef);
    if (product === undefined) continue;
    if (offer.prices.length === 0) continue;
    const choice = choosePrice(offer.prices, configuredPriceType);
    if (!choice.ok) {
      skipped.push({
        externalRef: offer.externalRef,
        reason: choice.reason,
        priceTypes: choice.priceTypes,
      });
      continue;
    }
    if (!isHomeCurrency(choice.price.currency)) {
      skipped.push({ externalRef: offer.externalRef, reason: "foreign_currency" });
      continue;
    }
    const normalizedPrice = normalizeUnitPriceValue(choice.price.value);
    if (normalizedPrice === null) {
      skipped.push({ externalRef: offer.externalRef, reason: "invalid_price_value" });
      continue;
    }
    priceUpdates.push({ productId: product.id, unitPrice: normalizedPrice });
  }

  // Фото — первая <Картинка> позиции, чья карточка известна (старая или
  // новая связь). Остальные картинки сознательно игнорируются (спека §1).
  const images: ImageWork[] = [];
  for (const item of items) {
    if (item.images.length === 0) continue;
    const product = knownByRef.get(item.externalRef) ?? linkedByRef.get(item.externalRef);
    if (product === undefined) continue;
    images.push({ productId: product.id, source: item.images[0]! });
  }

  const candidates: CandidateItem[] = unmatchedItems
    .filter((item) => !linkedByRef.has(item.externalRef))
    .map((item) => ({
      externalRef: item.externalRef,
      name: item.name,
      article: item.article,
      unit: item.unit,
      gtin: gtinByRef.get(item.externalRef) ?? null,
    }));

  return {
    links,
    priceUpdates,
    images,
    candidates,
    skipped,
    gtinConflicts,
    gtinAmbiguities,
    invalidBarcodes,
  };
}
```

Существовавшие в старом теле комментарии про «пропало из выгрузки», «каталог owns product creation» — перенести к соответствующим строкам, не терять.

4. Существующие тесты файла звали `decideApplication({ known: [...] })` — переписать на `products: [product(id, gtin, externalRef)]` (для старых сценариев любой уникальный gtin, например `"00000000000017"`, `"00000000000024"`…: сгенерировать валидные через `normalizeToGtin14` в тест-хелпере нельзя — он требует валидный вход; проще захардкодить несколько проверенных).

- [ ] **Step 4: Тесты зелёные**

Run: `pnpm --filter @markiro/api test -- commerceml-apply` → PASS.
Run: `pnpm --filter @markiro/api typecheck` — упадёт контроллер (`KnownProduct` исчез): это ожидаемо, чинится в Task 6. Если политика «каждый коммит компилируется» важнее — временно оставить в контроллере минимальную адаптацию: `products: knownRows.map(...)` c запросом gtin14 уже сейчас (маленький кусок Task 6, шаг 3 там это дополнит журналом/worklist'ом).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exchange/commerceml/apply.ts apps/api/test/commerceml-apply.test.ts apps/api/src/modules/exchange/exchange.controller.ts
git commit -m "feat(exchange): decideApplication планирует автосвязь по GTIN и фото"
```

---

### Task 3: Схема — `integration_candidates.gtin`

**Files:**

- Modify: `packages/db/src/schema/integrations.ts`
- Create: `packages/db/migrations/00XX_*.sql` (генерируется)

**Interfaces:**

- Produces: колонка `integrationCandidates.gtin` (`text`, nullable) — Task 6 пишет, Task 7 читает.

- [ ] **Step 1: Поле в схеме**

В `integrationCandidates` после `unit`:

```ts
    /** Нормализованный GTIN-14 из штрихкода файла — для экрана связки и
     *  автосвязи следующим обменом, когда карточка появится позже позиции.
     *  Нормализация и контрольная цифра проверены на стороне API
     *  (@markiro/domain) до записи; NULL — штрихкода не было или он кривой. */
    gtin: text("gtin"),
```

- [ ] **Step 2: Сгенерировать миграцию**

Run: `pnpm --filter @markiro/db db:generate`
Expected: новый файл `packages/db/migrations/00XX_….sql` с единственным
`ALTER TABLE "integration_candidates" ADD COLUMN "gtin" text;`. Проверить глазами, что ничего лишнего не сгенерировалось (drizzle-kit иногда подтягивает дрейф).
Проверить, что sqlite-схема станции не затронута: `grep -rn "integration_candidates" packages/db/src` — таблица только в pg-схеме.

- [ ] **Step 3: Прогнать сборку пакета**

Run: `pnpm --filter @markiro/db build && pnpm --filter @markiro/db typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/integrations.ts packages/db/migrations
git commit -m "feat(db): gtin у кандидатов интеграции"
```

---

### Task 4: `image-download.ts` — скачивание картинки по URL с SSRF-защитой

**Files:**

- Create: `apps/api/src/modules/exchange/commerceml/image-download.ts`
- Test: `apps/api/test/commerceml-image-download.test.ts`

**Interfaces:**

- Produces (для Task 6):

```ts
export class ImageDownloadError extends Error {
  constructor(reason: ImageDownloadReason, detail?: string);
  readonly reason: ImageDownloadReason;
}
export type ImageDownloadReason =
  | "not_https"
  | "forbidden_address"
  | "too_large"
  | "timeout"
  | "too_many_redirects"
  | "bad_status"
  | "network";
export function isForbiddenAddress(address: string): boolean;
export function downloadImage(
  url: string,
  deps?: { request?: typeof httpsRequest },
): Promise<Buffer>;
```

- [ ] **Step 1: Failing-тесты**

`apps/api/test/commerceml-image-download.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  downloadImage,
  ImageDownloadError,
  isForbiddenAddress,
} from "../src/modules/exchange/commerceml/image-download";

describe("isForbiddenAddress", () => {
  it.each([
    ["10.0.0.1", true],
    ["127.0.0.1", true],
    ["169.254.1.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["0.0.0.0", true],
    ["100.64.0.1", true],
    ["::1", true],
    ["fc00::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["2606:2800:220:1::1", false],
  ])("%s -> %s", (address, forbidden) => {
    expect(isForbiddenAddress(address)).toBe(forbidden);
  });
});

/** Фейковый https.request: маршрутизирует по URL, отдаёт статус/заголовки/тело чанками. */
type FakeRoute = { status: number; headers?: Record<string, string>; chunks?: Buffer[] };
function fakeRequestFor(routes: Record<string, FakeRoute>): any {
  return (url: URL, _options: unknown, onResponse: (res: any) => void) => {
    const req = Object.assign(new EventEmitter(), {
      end() {
        const route = routes[url.toString()];
        if (!route) {
          queueMicrotask(() => req.emit("error", new Error(`no fake route: ${url}`)));
          return;
        }
        const res = new PassThrough() as any;
        res.statusCode = route.status;
        res.headers = route.headers ?? {};
        queueMicrotask(() => {
          onResponse(res);
          for (const chunk of route.chunks ?? []) res.write(chunk);
          res.end();
        });
      },
      destroy() {
        /* совместимость с таймаут-веткой */
      },
    });
    return req;
  };
}

describe("downloadImage", () => {
  it("отдаёт тело при 200", async () => {
    const request = fakeRequestFor({
      "https://disk.sbis.ru/x": { status: 200, chunks: [Buffer.from("ab"), Buffer.from("cd")] },
    });
    await expect(downloadImage("https://disk.sbis.ru/x", { request })).resolves.toEqual(
      Buffer.from("abcd"),
    );
  });

  it("не https — отказ без единого запроса", async () => {
    await expect(
      downloadImage("http://disk.sbis.ru/x", { request: fakeRequestFor({}) }),
    ).rejects.toMatchObject({ reason: "not_https" });
  });

  it("ходит по редиректу и режет их после третьего", async () => {
    const hop = (n: number, to: string): FakeRoute => ({ status: 302, headers: { location: to } });
    const request = fakeRequestFor({
      "https://a.example/1": hop(1, "https://a.example/2"),
      "https://a.example/2": hop(2, "https://a.example/3"),
      "https://a.example/3": hop(3, "https://a.example/4"),
      "https://a.example/4": hop(4, "https://a.example/5"),
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toMatchObject({
      reason: "too_many_redirects",
    });
  });

  it("редирект на http — отказ", async () => {
    const request = fakeRequestFor({
      "https://a.example/1": { status: 302, headers: { location: "http://a.example/2" } },
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toMatchObject({
      reason: "not_https",
    });
  });

  it("обрывает тело больше лимита", async () => {
    const request = fakeRequestFor({
      "https://a.example/big": { status: 200, chunks: [Buffer.alloc(5 * 1024 * 1024 + 1)] },
    });
    await expect(downloadImage("https://a.example/big", { request })).rejects.toMatchObject({
      reason: "too_large",
    });
  });

  it("не-2xx без location — bad_status", async () => {
    const request = fakeRequestFor({ "https://a.example/x": { status: 404 } });
    await expect(downloadImage("https://a.example/x", { request })).rejects.toMatchObject({
      reason: "bad_status",
    });
  });
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `pnpm --filter @markiro/api test -- commerceml-image-download`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализация**

`apps/api/src/modules/exchange/commerceml/image-download.ts`:

```ts
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

/**
 * Скачивание `<Картинка>`-URL для mode=import. Значение приходит из файла на
 * НЕгейченном маршруте (см. exchange.controller.ts, класс-коммент) — то есть
 * URL контролирует внешняя сторона, и без ограничений это готовый SSRF:
 * «скачай http://169.254.169.254/…» руками нашего сервера. Отсюда правила:
 * только https, резолв через guardedLookup С ОТКАЗОМ приватным/служебным
 * адресам В МОМЕНТ КОННЕКТА (не заранее — иначе TOCTOU через DNS-rebinding),
 * потолок тела, таймаут на весь заход, редиректы вручную и под теми же
 * проверками.
 */
export const IMAGE_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024; // = MAX_SOURCE_BYTES медиа-пайплайна
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
export const IMAGE_DOWNLOAD_MAX_REDIRECTS = 3;

export type ImageDownloadReason =
  | "not_https"
  | "forbidden_address"
  | "too_large"
  | "timeout"
  | "too_many_redirects"
  | "bad_status"
  | "network";

export class ImageDownloadError extends Error {
  constructor(
    public readonly reason: ImageDownloadReason,
    detail?: string,
  ) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

function isForbiddenIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT
  return false;
}

/** true для адресов, куда серверу ходить нельзя: loopback, RFC1918, link-local, ULA, v4-mapped. Не-IP тоже запрещён (сюда приходит уже РЕЗУЛЬТАТ резолва). */
export function isForbiddenAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isForbiddenIpv4(address);
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      return isIP(mapped) === 4 ? isForbiddenIpv4(mapped) : true;
    }
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return true;
}

/**
 * `lookup`-опция net/tls-коннекта: резолвит сам и отдаёт адрес сокету ТОЛЬКО
 * если ни один из результатов не запрещён. Проверка здесь, а не до запроса,
 * закрывает DNS-rebinding: сокет соединится ровно с тем адресом, который
 * прошёл проверку.
 */
function guardedLookup(
  hostname: string,
  options: object,
  callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
): void {
  dnsLookup(hostname, { all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const forbidden = addresses.find((entry) => isForbiddenAddress(entry.address));
    if (forbidden !== undefined || addresses.length === 0) {
      callback(
        Object.assign(new Error(`forbidden address for ${hostname}`), { code: "EFORBIDDEN" }),
        "",
        0,
      );
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}

export interface ImageDownloadDeps {
  /** Подменяется в тестах; в бою — node:https.request. */
  request?: typeof httpsRequest;
}

/** Один хоп: запрос, чтение тела под потолком, или редирект (location). */
function fetchHop(
  url: URL,
  request: typeof httpsRequest,
  budgetLeft: () => number,
): Promise<{ redirectTo: string } | { body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "GET", lookup: guardedLookup, timeout: IMAGE_DOWNLOAD_TIMEOUT_MS },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string") {
          res.resume(); // дочитать и отпустить сокет
          resolve({ redirectTo: new URL(location, url).toString() });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new ImageDownloadError("bad_status", `HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > IMAGE_DOWNLOAD_MAX_BYTES) {
            req.destroy();
            reject(new ImageDownloadError("too_large", `> ${IMAGE_DOWNLOAD_MAX_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ body: Buffer.concat(chunks) }));
        res.on("error", (cause: Error) => reject(new ImageDownloadError("network", cause.message)));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new ImageDownloadError("timeout", `${budgetLeft()}ms`));
    });
    req.on("error", (cause: NodeJS.ErrnoException) => {
      reject(
        cause.code === "EFORBIDDEN"
          ? new ImageDownloadError("forbidden_address", cause.message)
          : new ImageDownloadError("network", cause.message),
      );
    });
    req.end();
  });
}

export async function downloadImage(rawUrl: string, deps: ImageDownloadDeps = {}): Promise<Buffer> {
  const request = deps.request ?? httpsRequest;
  let current = rawUrl;
  for (let hop = 0; hop <= IMAGE_DOWNLOAD_MAX_REDIRECTS; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new ImageDownloadError("network", `не URL: ${current}`);
    }
    if (url.protocol !== "https:") throw new ImageDownloadError("not_https", url.protocol);
    const outcome = await fetchHop(url, request, () => IMAGE_DOWNLOAD_TIMEOUT_MS);
    if ("body" in outcome) return outcome.body;
    current = outcome.redirectTo;
  }
  throw new ImageDownloadError("too_many_redirects", `> ${IMAGE_DOWNLOAD_MAX_REDIRECTS}`);
}
```

Примечание для реализатора: фейк в тесте зовёт `request(url, options, cb)` и игнорирует options — сигнатура совпадает с node:https. Если типы node ругаются на `lookup` в опциях `https.request` — это опция `net.connect`/`tls.connect`, она легально проходит сквозь `http.request` options (`LookupFunction`); при необходимости привести поле к `RequestOptions["lookup"]`.

- [ ] **Step 4: Тесты зелёные**

Run: `pnpm --filter @markiro/api test -- commerceml-image-download` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exchange/commerceml/image-download.ts apps/api/test/commerceml-image-download.test.ts
git commit -m "feat(exchange): скачивание картинки по URL с SSRF-защитой"
```

---

### Task 5: `ProductsService.applyExchangeImage` — машинный актор + дедуп

**Files:**

- Modify: `apps/api/src/modules/products/products.service.ts`

**Interfaces:**

- Consumes: существующие `processProductImage`, `findRow`, `imageDescriptor`, аудит-writer'ы.
- Produces (для Task 6): `applyExchangeImage(tenantId: string, productId: string, source: Buffer): Promise<"applied" | "unchanged">` — кидает те же `NotFoundException`/`BadRequestException`/`ServiceUnavailableException`, что `uploadImage`.

- [ ] **Step 1: Рефакторинг без изменения поведения**

1. В `writeSuccessAudit` и `writeFailureAudit` тип параметра `actorUserId: string` → `actorUserId: string | null` (колонка `tenant_audit_events.actor_user_id` nullable, FK `set null` — машинному актору юзера взять неоткуда; канал виден по `after.source` ниже).
2. Из `uploadImage` извлечь всё от `const descriptor: ProductImageDescriptor = {…}` до `await this.mediaAssets.cleanupDeletingTenantAsset(…)` включительно в приватный метод — тело переносится ДОСЛОВНО, меняются только `actorUserId`-проброс и завершение:

```ts
/** Общий хвост uploadImage/applyExchangeImage: staging-asset -> storage ->
 *  активация/переключение -> cleanup прежнего. `actorUserId: null` — обмен
 *  (машинный актор), аудит остаётся, юзера в нём нет. */
private async activateProcessedImage(
  tenantId: string,
  actorUserId: string | null,
  productId: string,
  image: ProcessedProductImage,
  initialImage: ProductImageDescriptor | null,
): Promise<void> { /* перенесённое тело */ }
```

`uploadImage` после переноса:

```ts
await this.activateProcessedImage(tenantId, actorUserId, productId, image, initialImage);
return this.getProduct(tenantId, productId);
```

(Импортировать `type ProcessedProductImage` из `../media/product-image-processor`.)

- [ ] **Step 2: Существующие тесты зелёные после рефакторинга**

Run: `pnpm --filter @markiro/api test -- product` и `pnpm --filter @markiro/api typecheck`
Expected: PASS — поведение не менялось.

- [ ] **Step 3: Новый метод**

```ts
/**
 * Фото из обмена (CommerceML `<Картинка>`): тот же пайплайн, что ручная
 * загрузка, но актор — машина (`actorUserId: null`), а совпадение checksum
 * обработанного webp с текущим активным фото — «unchanged», не новый asset:
 * без этого КАЖДЫЙ обмен с той же картинкой плодил бы asset + запись аудита.
 * Сравнивается checksum ОБРАБОТАННОГО изображения (это то, что хранит
 * media_assets.checksum), а не исходных байт — sharp детерминирован для
 * одного входа/версии; смена версии sharp в худшем случае даст одну лишнюю
 * перезаливку.
 */
async applyExchangeImage(
  tenantId: string,
  productId: string,
  source: Buffer,
): Promise<"applied" | "unchanged"> {
  const product = await this.findRow(tenantId, productId);
  if (!product) throw new NotFoundException();
  const initialImage = this.imageDescriptor(product);

  let image: ProcessedProductImage;
  try {
    image = await processProductImage(source);
  } catch (error) {
    const reason = isImageInfrastructureFailure(error) ? "processing_unavailable" : "invalid_image";
    await this.writeFailureAudit(tenantId, null, productId, initialImage, null, reason);
    if (reason === "processing_unavailable") {
      throw new ServiceUnavailableException("Product image processing is unavailable");
    }
    throw new BadRequestException(errorMessage(error));
  }

  if (initialImage !== null && initialImage.checksum === image.checksum) return "unchanged";
  await this.activateProcessedImage(tenantId, null, productId, image, initialImage);
  return "applied";
}
```

- [ ] **Step 4: Typecheck + прогон**

Run: `pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api test -- product`
Expected: PASS. Поведенческий тест метода — в e2e Task 6 (там уже есть вся обвязка AppModule/подписки; дублировать её здесь ради юнита — дороже, чем ценность).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/products/products.service.ts
git commit -m "feat(products): applyExchangeImage — фото из обмена с дедупом и машинным актором"
```

---

### Task 6: Контроллер — worklist link/price/image/candidate и журнал

**Files:**

- Modify: `apps/api/src/modules/exchange/exchange.controller.ts`
- Modify: `apps/api/src/modules/exchange/exchange.module.ts`
- Test: `apps/api/test/exchange-import.e2e.test.ts`

**Interfaces:**

- Consumes: `ApplicationPlan`/`CatalogProduct` (Task 2), `integrationCandidates.gtin` (Task 3), `downloadImage`/`ImageDownloadError` (Task 4), `ProductsService.applyExchangeImage` (Task 5).
- Produces: поведение маршрута; новые журнальные события (см. Step 3.5).

- [ ] **Step 1: Failing e2e**

В `apps/api/test/exchange-import.e2e.test.ts` добавить хелперы и тесты (обвязка — как в существующих: `checkauth` → `mode=file` → `mode=import`):

```ts
/** 1x1 PNG. Если normalizeBoundedImage отвергнет 1x1 (invalid_dimensions) — заменить на 8x8. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function catalogWithBarcodeXml(
  guid: string,
  name: string,
  barcode: string,
  image?: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.05">
 <Каталог><Товары>
  <Товар>
   <Ид>${guid}</Ид>
   <Наименование>${name}</Наименование>
   <Штрихкод>${barcode}</Штрихкод>
   ${image === undefined ? "" : `<Картинка>${image}</Картинка>`}
  </Товар>
 </Товары></Каталог>
</КоммерческаяИнформация>`;
}
```

Сценарии (каждый — свой `it`, свой тенант через существующий сетап):

1. **Автосвязь + цена одним раундом.** Создать товар (gtin14 `04680089900253`, `externalRef: null`, цена 100). Файл: каталог с `Штрихкод 4680089900253` + offers с ценой `9200.00`. После import: `products.externalRef === guid`, `unitPrice === "9200.00"`, кандидатов 0, есть событие `связан автоматически по GTIN` (grain item, outcome ok).
2. **Конфликт.** Товар с тем же gtin14, но `externalRef: "другой-guid"`. После import: externalRef не изменился, есть кандидат с `gtin === "04680089900253"`, есть warn-событие `конфликт GTIN`.
3. **Кандидат с GTIN.** Товара с таким gtin нет → кандидат, в строке `integration_candidates.gtin === "04680089900253"`.
4. **Фото из файла сеанса.** Связанный товар; `mode=file` c `filename=import_files/1.png` (тело TINY_PNG), затем import каталога с `<Картинка>import_files/1.png</Картинка>`. После: у товара есть строка `product_images`, asset `active`. Повторить import тем же файлом → количество строк `media_assets` этого тенанта НЕ выросло (дедуп «unchanged»).
5. **Битое фото не валит раунд.** `<Картинка>import_files/missing.png</Картинка>` без загрузки файла → ответ `success`, событие warn `фото не применено`, цена/связь того же файла применились.

- [ ] **Step 2: Убедиться, что падают**

Run: `pnpm --filter @markiro/api test -- exchange-import`
Expected: FAIL (новые сценарии).

- [ ] **Step 3: Реализация в контроллере**

3.1. Модуль: `ExchangeModule.imports` добавить `ProductsModule` (он экспортирует `ProductsService`); в конструктор контроллера — `private readonly products: ProductsService`.

3.2. Импорты: `decideApplication, type CatalogProduct` из `./commerceml/apply` (убрать `KnownProduct`); `downloadImage` из `./commerceml/image-download`; `ProductsService` из `../products/products.service`.

3.3. `ImportWorkItem` и `fingerprintOf`:

```ts
type ImportWorkItem =
  | { kind: "link"; productId: string; externalRef: string; gtin: string }
  | { kind: "price"; productId: string; unitPrice: string }
  | { kind: "image"; productId: string; source: string }
  | {
      kind: "candidate";
      externalRef: string;
      name: string;
      article: string | null;
      unit: string | null;
      gtin: string | null;
    };

function fingerprintOf(worklist: ImportWorkItem[]): string {
  const keys = worklist.map((item) => {
    switch (item.kind) {
      case "link":
        return `l:${item.productId}`;
      case "price":
        return `p:${item.productId}`;
      case "image":
        return `i:${item.productId}`;
      case "candidate":
        return `c:${item.externalRef}`;
    }
  });
  const hash = createHash("sha256").update(keys.join(" ")).digest("hex");
  return `${worklist.length}:${hash}`;
}
```

3.4. В `import()` — карточки целиком (заменяет `knownRows`/`known`):

```ts
const productRows: CatalogProduct[] = await this.db
  .select({
    id: schema.products.id,
    gtin14: schema.products.gtin14,
    externalRef: schema.products.externalRef,
  })
  .from(schema.products)
  .where(eq(schema.products.tenantId, session.tenantId));

const plan = decideApplication({ products: productRows, items, offers, configuredPriceType });

// «Без связанного товара» теперь означает: ни давней связи, ни автосвязи
// ЭТОГО раунда — иначе только что связанное предложение попадало бы в warn.
const matchedRefs = new Set([
  ...productRows.filter((p) => p.externalRef !== null).map((p) => p.externalRef!),
  ...plan.links.map((link) => link.externalRef),
]);
const unmatchedOfferRefs = [
  ...new Set(offers.filter((o) => !matchedRefs.has(o.externalRef)).map((o) => o.externalRef)),
];

const worklist: ImportWorkItem[] = [
  // Связь раньше цены, цена раньше фото (фото — самый тяжёлый шаг), кандидаты последними.
  ...plan.links.map((link): ImportWorkItem => ({ kind: "link", ...link })),
  ...plan.priceUpdates.map((u): ImportWorkItem => ({
    kind: "price",
    productId: u.productId,
    unitPrice: u.unitPrice,
  })),
  ...plan.images.map((img): ImportWorkItem => ({ kind: "image", ...img })),
  ...plan.candidates.map((c): ImportWorkItem => ({ kind: "candidate", ...c })),
];
```

3.5. Журнал при `offset === 0` (после существующего блока skipped/unmatched):

```ts
for (const link of plan.links) {
  await this.journal.append({
    tenantId: session.tenantId,
    channelType: session.channelType,
    sessionId: session.id,
    direction: "in",
    outcome: "ok",
    grain: "item",
    message: `связан автоматически по GTIN: ${link.externalRef}`,
    details: { externalRef: link.externalRef, productId: link.productId, gtin: link.gtin },
  });
}
for (const conflict of plan.gtinConflicts) {
  await this.journal.append({
    tenantId: session.tenantId,
    channelType: session.channelType,
    sessionId: session.id,
    direction: "in",
    outcome: "warn",
    grain: "item",
    message: `конфликт GTIN: карточка уже связана с другим Ид: ${conflict.externalRef}`,
    details: { ...conflict },
  });
}
for (const ambiguity of plan.gtinAmbiguities) {
  await this.journal.append({
    tenantId: session.tenantId,
    channelType: session.channelType,
    sessionId: session.id,
    direction: "in",
    outcome: "warn",
    grain: "item",
    message: `GTIN у нескольких позиций файла — автосвязь не выполнена: ${ambiguity.gtin}`,
    details: { ...ambiguity },
  });
}
if (plan.invalidBarcodes > 0) {
  await this.journal.append({
    tenantId: session.tenantId,
    channelType: session.channelType,
    sessionId: session.id,
    direction: "in",
    outcome: "warn",
    grain: "session",
    message: `штрихкодов отброшено (не GTIN): ${plan.invalidBarcodes}`,
    details: { count: plan.invalidBarcodes },
  });
}
```

3.6. `applyWorkItem` — две новые ветки и gtin у кандидата:

```ts
if (work.kind === "link") {
  // isNull-гард: админ мог связать карточку руками между раундами; тихо
  // не перезаписываем — следующий обмен увидит её связанной и пересчитает план.
  await this.db
    .update(schema.products)
    .set({ externalRef: work.externalRef })
    .where(
      and(
        eq(schema.products.tenantId, session.tenantId),
        eq(schema.products.id, work.productId),
        isNull(schema.products.externalRef),
      ),
    );
  return;
}

if (work.kind === "image") {
  await this.applyImageWorkItem(session, work);
  return;
}
```

У candidate-upsert в `values` и `set` добавить `gtin: work.gtin`.

3.7. Новый приватный метод:

```ts
/**
 * Одно фото: достаём байты (файл сеанса или https-URL), прогоняем через
 * общий media-пайплайн. ЛЮБАЯ ошибка — warn по позиции, не падение раунда
 * (спека §6): фото — украшение карточки, а не учётный факт; принятое
 * ограничение — транзиентная ошибка БД внутри applyExchangeImage тоже
 * попадёт в warn и не будет повторена до следующего обмена.
 */
private async applyImageWorkItem(
  session: ResolvedExchangeSession,
  work: { productId: string; source: string },
): Promise<void> {
  try {
    let source: Buffer;
    if (/^https?:\/\//i.test(work.source)) {
      source = await downloadImage(work.source); // http:// отвергнет сам (not_https)
    } else {
      source = await this.sessions.assemble(session.id, work.source);
      if (source.byteLength === 0) {
        // assemble возвращает пустой Buffer, когда файла в сеансе нет —
        // назвать причину честно, а не «invalid image» из sharp.
        throw new Error(`файл картинки «${work.source}» не найден в сеансе`);
      }
    }
    await this.products.applyExchangeImage(session.tenantId, work.productId, source);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "in",
      outcome: "warn",
      grain: "item",
      message: `фото не применено: ${detail}`,
      details: { productId: work.productId, source: work.source },
    });
  }
}
```

3.8. Итоговое событие файла — дополнить `details`:

```ts
details: {
  filename,
  updated: plan.priceUpdates.length,
  linked: plan.links.length,
  images: plan.images.length,
  candidates: plan.candidates.length,
  skipped: plan.skipped.length,
  gtinConflicts: plan.gtinConflicts.length,
  invalidBarcodes: plan.invalidBarcodes,
  unmatchedOffers: unmatchedOfferRefs.length,
},
```

3.9. Класс-коммент `applyWorkItem` («price трогает только unit_price») дополнить: link трогает только `external_ref`, image — только фото; имя/GTIN карточки — по-прежнему никогда.

- [ ] **Step 4: Все тесты зелёные**

Run: `pnpm --filter @markiro/api test -- exchange` затем весь пакет `pnpm --filter @markiro/api test` и `pnpm --filter @markiro/api typecheck`
Expected: PASS (существующие import-тесты могли опираться на старый worklist-порядок/детали события — поправить ожидания, поведение цены не менялось).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exchange apps/api/test/exchange-import.e2e.test.ts
git commit -m "feat(exchange): автосвязь по GTIN и фото товара в mode=import"
```

---

### Task 7: GTIN в очереди кандидатов (DTO + админка)

**Files:**

- Modify: `apps/api/src/modules/integrations/dto.ts` (в `CandidateDto` после `unit`: `gtin: string | null;`)
- Modify: `apps/api/src/modules/integrations/integrations.service.ts` (`listCandidates`: в маппинг строки добавить `gtin: row.gtin,`)
- Modify: `apps/admin/src/pages/integrations/api.ts` (зеркальный `CandidateDto` — то же поле)
- Modify: `apps/admin/src/pages/integrations/CandidatesQueue.tsx`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/integrations-candidates.test.tsx`, api-тест интеграций

**Interfaces:**

- Consumes: `integrationCandidates.gtin` (Task 3, пишется Task 6).
- Produces: `CandidateDto.gtin: string | null` на обоих концах.

- [ ] **Step 1: Failing-тест API**

В тот тест, что уже проверяет `listCandidates`/`GET /integrations/:type/candidates` (см. `apps/api/test/integrations.e2e.test.ts`), добавить: у кандидата, вставленного с `gtin: "04680089900253"`, поле возвращается как есть; у старого без gtin — `null`.

- [ ] **Step 2: Реализация API** — два однострочных изменения из блока Files. Run: `pnpm --filter @markiro/api test -- integrations` → PASS.

- [ ] **Step 3: Админка**

В `CandidatesQueue.tsx` колонка между `article` и `externalRef`:

```tsx
{
  key: "gtin",
  title: t("pages.integrations.channel.candidates.table.gtin"),
  mono: true,
  render: (row) => row.gtin ?? "—",
},
```

В i18n рядом с `candidates.table.article`: `"gtin": "GTIN"` (в обоих языках). В `apps/admin/test/integrations-candidates.test.tsx` — фикстуре кандидата добавить `gtin`, проверить, что значение видно в таблице.

- [ ] **Step 4: Тесты зелёные**

Run: `pnpm --filter @markiro/admin test -- integrations-candidates && pnpm --filter @markiro/admin typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/integrations apps/admin/src apps/admin/test apps/api/test
git commit -m "feat(integrations): GTIN кандидата в DTO и очереди админки"
```

---

### Task 8: Приёмочный чек-лист и финальная проверка

**Files:**

- Modify: `docs/1c-exchange-acceptance-checklist.md`

- [ ] **Step 1: Чек-лист**

Добавить раздел (форма — как соседние пункты файла):

```markdown
## GTIN, автосвязь и фото (2026-08-28)

Предположения этого среза не проверены на живом обмене (в т.ч. СБИС —
он ходит тем же протоколом). Проверить на первом реальном сеансе:

- [ ] Штрихкод приходит тегом `<Штрихкод>` у `<Товар>` (или `<Предложение>`);
      если конфигурация шлёт НЕСКОЛЬКО `<Штрихкод>` — сейчас это читается как
      «штрихкода нет» (см. parse.ts) — зафиксировать и решить.
- [ ] `<Картинка>` несёт относительный путь, а файлы картинок реально
      приходят через `mode=file` до import.xml; если это URL — работает
      https-ветка (downloadImage), проверить доступность без авторизации.
- [ ] Автосвязь: позиция с EAN-13 существующей карточки связалась, событие
      «связан автоматически по GTIN» в журнале.
- [ ] Фото появилось в карточке; повторный обмен не плодит media_assets.
- [ ] Тип цены в файле называется так, как задан в настройке канала
      (для СБИС ожидаем «Базовая»).
```

- [ ] **Step 2: Полный прогон воркспейса**

Run: `pnpm turbo run typecheck lint test --filter=@markiro/api --filter=@markiro/admin --filter=@markiro/db`
Expected: PASS везде.

- [ ] **Step 3: Commit**

```bash
git add docs/1c-exchange-acceptance-checklist.md
git commit -m "docs: приёмка GTIN/автосвязи/фото в чек-листе обмена"
```
