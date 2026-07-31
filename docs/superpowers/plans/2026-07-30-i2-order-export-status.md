# И-2 «Выгрузка заявок и статусы» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every pickup order Markiro creates is pushed out to the tenant's 1С over the existing CommerceML exchange the moment it exists, and a later status 1С reports back (пробит / списан / отменён) is reconciled onto that same order — so an administrator stops re-typing orders into 1С by hand.

**Architecture:** Reuses И-1's transport (`/1c_exchange`, `checkauth`/`init`, sessions, journal) unchanged. Adds two new protocol modes on the SAME route — `mode=query` (GET, 1С pulls pending orders as a CommerceML document) and `mode=success` (POST, 1С confirms receipt) — plus a `type=sale` branch on the EXISTING `mode=file`/`mode=import` pair (1С pushes back changed orders' statuses, read through a per-connection configurable requisite name and value→status table, per spec §6's "данные, а не код"). All planning/document-building logic is pure functions with no DB or HTTP access, mirroring `commerceml/apply.ts`'s existing shape; the guarded `pending → {punched, writtenoff, cancelled}` transition lives in `PickupOrdersService`, next to `resolve()`/`cancel()`, which already enforce that exact invariant.

**Tech Stack:** NestJS 11, Drizzle 0.45 + Postgres, `fast-xml-parser` 5.10.1 (parsing only — the outbound XML is hand-built, see Task 4's own note on why), Vitest 4, React 19 + react-hook-form (admin).

## Global Constraints

- Every new DB-facing method follows the existing tenant-scoping convention: every query is filtered by `tenantId`, no exceptions.
- No new npm dependency. `fast-xml-parser`'s own `XMLBuilder` is `@deprecated` in this pinned version's own types (`fxp.d.ts`) in favour of a separate package — pulling that package in would need to clear this workspace's `pnpm-workspace.yaml` `minimumReleaseAge` supply-chain quarantine for a document built entirely from our own DB data (never attacker-controlled), so Task 4 hand-rolls the tiny amount of escaping actually needed instead.
- Every journal event follows `JournalService.append`'s existing shape (`AppendEventInput`) — no new event grain, no new outcome value.
- A single bad row inside a batch (one order that can't be applied, one document with an unmapped status) must never abort the rest of that batch's processing — mirrors `commerceml/apply.ts`'s existing skip-and-continue discipline.
- `pending → {punched, writtenoff, cancelled}` is the ONLY transition this whole feature is allowed to trigger. Never `pending` itself, never terminal → anything. Spec §6: "Инварианты жизненного цикла сильнее внешнего статуса."
- Every new Russian-facing string needs both `ru.json` and `en.json` entries — never ship a `ru`-only or `en`-only key.

---

## Task 1: Schema — `pickupOrders.exportedAt`

**Files:**

- Modify: `packages/db/src/schema/pickup.ts:175-222` (the `pickupOrders` table)
- Create: `packages/db/migrations/00XX_<generated-name>.sql` (drizzle-kit generates the number/name — expect `0019_...` given the current latest is `0018_stiff_genesis.sql`; verify the actual generated file only adds one nullable column, no drops)
- Modify: `packages/db/test/pickup-schema.test.ts`

**Interfaces:**

- Produces: `schema.pickupOrders.exportedAt` (`timestamp | null`), consumed by Task 6 (`findExportCandidates`, filters `isNull`), Task 11 (`mode=success` handler, sets it), and Task 15 (admin DTOs).

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/pickup.ts`, inside the `pickupOrders` table's column object (right after `resolvedByUserId: text("resolved_by_user_id"),` at line 198), add:

```ts
    resolvedByUserId: text("resolved_by_user_id"),
    /**
     * Set once 1С confirms receipt of this order via `mode=success`
     * (плана И-2 §5, exchange.controller.ts). `null` means "still eligible
     * for `mode=query`" -- an order is offered EVERY round until this is set,
     * per spec's "до него документ предлагается снова" (repeat-until-
     * confirmed, not repeat-forever: once set, `findExportCandidates` never
     * selects this row again). Orthogonal to `status`: an order is exported
     * WHILE STILL `pending` (спека §5, "выгружаем сразу при создании"), well
     * before any resolve/cancel/1С-status-reconciliation touches `status`.
     */
    exportedAt: timestamp("exported_at", { withTimezone: true }),
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm --filter @markiro/db exec drizzle-kit generate
```

Read the generated SQL file under `packages/db/migrations/`. It must contain exactly one statement: `ALTER TABLE "pickup_orders" ADD COLUMN "exported_at" timestamp with time zone;` — no drops, no other tables touched. If drizzle-kit generates anything else (e.g. because the schema file list in `drizzle.config.ts` needs updating), stop and investigate before continuing — `pickup.ts` is an existing, already-migrated file, so this should not be needed, but confirm rather than assume.

- [ ] **Step 3: Apply the migration to the local dev DB**

```bash
pnpm --filter @markiro/db exec drizzle-kit migrate
```

- [ ] **Step 4: Add a schema-level test**

In `packages/db/test/pickup-schema.test.ts`, add a new `it()` block after the existing two (after line ~96, following the same `order1`/`order2` fixtures already set up in `beforeAll`):

```ts
it("exported_at defaults to null and can be set", async () => {
  const [before] = await db
    .select({ exportedAt: schema.pickupOrders.exportedAt })
    .from(schema.pickupOrders)
    .where(eq(schema.pickupOrders.id, order1));
  expect(before?.exportedAt).toBeNull();

  const now = new Date();
  await db
    .update(schema.pickupOrders)
    .set({ exportedAt: now })
    .where(eq(schema.pickupOrders.id, order1));

  const [after] = await db
    .select({ exportedAt: schema.pickupOrders.exportedAt })
    .from(schema.pickupOrders)
    .where(eq(schema.pickupOrders.id, order1));
  expect(after?.exportedAt?.getTime()).toBe(now.getTime());

  // Reset for any test after this one in the same file.
  await db
    .update(schema.pickupOrders)
    .set({ exportedAt: null })
    .where(eq(schema.pickupOrders.id, order1));
});
```

- [ ] **Step 5: Run the test**

```bash
pnpm --filter @markiro/db exec vitest run test/pickup-schema.test.ts
```

Expected: PASS (3 tests: the two existing plus this new one).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/pickup.ts packages/db/migrations packages/db/test/pickup-schema.test.ts
git commit -m "feat(db): add pickup_orders.exported_at for the И-2 1С export flag"
```

---

## Task 2: Channel registry — new CommerceML settings

**Files:**

- Modify: `apps/api/src/modules/integrations/channel-registry.ts:44-69`
- Modify: `apps/api/test/channel-registry.test.ts`

**Interfaces:**

- Produces: three new optional keys on the `commercemlSettings` zod schema — `writeoffDocumentType?: string`, `orderStatusField?: string`, `statusMapping?: Record<string, "punched" | "writtenoff" | "cancelled">` — read by Task 10 (`buildOrdersDocument`'s settings), Task 12 (`importOrderStatuses`'s `settings.orderStatusField`/`settings.statusMapping`).

- [ ] **Step 1: Extend the schema**

In `apps/api/src/modules/integrations/channel-registry.ts`, replace the `commercemlSettings` declaration (lines 44-69):

```ts
const commercemlSettings = z
  .object({
    /**
     * Какой тип цены ложится в `products.unit_price`. Пусто — решаем по файлу.
     *
     * Принятое ограничение (final review, Fix 9): раз однажды заданное, это
     * значение нельзя осознанно вернуть обратно в «решаем по файлу» —
     * `.min(1)` не пускает пустую строку как валидное значение, а
     * `IntegrationsService.updateChannel` (integrations.service.ts) трактует
     * ОТСУТСТВИЕ ключа в патче как «не трогать», а не как «очистить». Клиент
     * (`ChannelPage.tsx`) как раз опускает ключ, когда поле формы пустое, так
     * что поле молча возвращает прежнее значение при следующей пересинхронизации
     * формы. Нужна отдельная форма представления «явно не задано» (например,
     * `null`), а не просто более мягкая схема здесь.
     */
    priceType: z.string().min(1).optional(),
    /** Разделять ли списание в свой тип документа (используется в И-2). */
    splitWriteoffDocument: z.boolean().default(false),
    /**
     * Значение `<ХозОперация>` для заявок на списание, когда
     * `splitWriteoffDocument` включён (плана И-2, спека §2/§5: "словарь
     * документов в конфигурациях разный; разделение — настройка, а не
     * допущение"). Без этого значения `splitWriteoffDocument: true` не меняет
     * ничего — `order-export.ts`'s `buildOrdersDocument` падает обратно на
     * единый тип документа по умолчанию, если это поле пусто.
     */
    writeoffDocumentType: z.string().min(1).optional(),
    /**
     * Название реквизита статуса заказа в ЭТОЙ конфигурации 1С (плана И-2,
     * спека §6). Стандартного названия нет — приёмочный чек-лист
     * (`docs/1c-exchange-acceptance-checklist.md`) прямо называет его
     * неизвестным до первого живого сеанса. Пусто — входящий статус вообще
     * не читается (спека §6: "по умолчанию слой выключен").
     */
    orderStatusField: z.string().min(1).optional(),
    /**
     * Таблица «внешнее значение реквизита → наш статус» (спека §6: "данные, а
     * не код"). Значение — один из трёх терминальных статусов
     * `pickup_order_status`, никогда `pending` (спека §6: "инварианты
     * жизненного цикла сильнее внешнего статуса" — сопоставление не может
     * протащить заказ назад в `pending`).
     */
    statusMapping: z.record(z.string(), z.enum(["punched", "writtenoff", "cancelled"])).optional(),
  })
  // Review fix (PR #32, item 8): plain `z.object()` silently STRIPS a key it
  // doesn't recognise -- `safeParse` still reports `success: true`, so a
  // typo'd field name (`pricetype`, `priceTyp`) used to come back a clean
  // 200 that changed nothing, the exact "сохранено, ничего не изменилось"
  // this method's own comment already warns about for the empty-patch case.
  // `.strict()` turns an unrecognised key into a validation failure instead.
  .strict();
```

- [ ] **Step 2: Add tests**

In `apps/api/test/channel-registry.test.ts`, add after the existing `"commerceml схема применяет default(false) для splitWriteoffDocument"` block (after line 71):

```ts
it("commerceml схема принимает orderStatusField и опциональна без него", () => {
  const withField = describeChannel("commerceml").settingsSchema.safeParse({
    orderStatusField: "СтатусЗаказа",
  });
  expect(withField.success).toBe(true);

  const withoutField = describeChannel("commerceml").settingsSchema.safeParse({});
  expect(withoutField.success).toBe(true);
});

it("commerceml схема отвергает пустой orderStatusField", () => {
  const empty = describeChannel("commerceml").settingsSchema.safeParse({ orderStatusField: "" });
  expect(empty.success).toBe(false);
});

it("commerceml схема принимает statusMapping только с известными значениями", () => {
  const ok = describeChannel("commerceml").settingsSchema.safeParse({
    statusMapping: { Оплачен: "punched", Списан: "writtenoff", Отменён: "cancelled" },
  });
  expect(ok.success).toBe(true);

  const bad = describeChannel("commerceml").settingsSchema.safeParse({
    statusMapping: { Оплачен: "pending" },
  });
  expect(bad.success).toBe(false);

  const alsoBad = describeChannel("commerceml").settingsSchema.safeParse({
    statusMapping: { Оплачен: "shipped" },
  });
  expect(alsoBad.success).toBe(false);
});

it("commerceml схема принимает writeoffDocumentType", () => {
  const ok = describeChannel("commerceml").settingsSchema.safeParse({
    writeoffDocumentType: "Списание товара",
  });
  expect(ok.success).toBe(true);
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm --filter @markiro/api exec vitest run test/channel-registry.test.ts
```

Expected: PASS (13 tests total).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/integrations/channel-registry.ts apps/api/test/channel-registry.test.ts
git commit -m "feat(api): add И-2 CommerceML settings (order status field, mapping, writeoff doc type)"
```

---

## Task 3: Export shared XML-parsing helpers from `parse.ts`

**Files:**

- Modify: `apps/api/src/modules/exchange/commerceml/parse.ts:80` (REPEATING_TAGS), `:206` (parseXml), `:225` (asObject), `:230` (dig), `:244` (textOf)

**Interfaces:**

- Produces: `parseXml`, `asObject`, `dig`, `textOf` now exported from `parse.ts` — consumed by Task 5's `order-status.ts`.
- No behavior change to any existing caller; this is purely widening visibility plus two more repeating tag names.

- [ ] **Step 1: Widen `REPEATING_TAGS`**

At `parse.ts:80`, replace:

```ts
const REPEATING_TAGS = new Set(["Товар", "Предложение", "Цена", "ТипЦены"]);
```

with:

```ts
/**
 * "Документ" and "ЗначениеРеквизита" added for плана И-2's outgoing/incoming
 * order documents (`order-export.ts`/`order-status.ts`) -- `<ПакетДокументов>`
 * carries zero or more `<Документ>`, and each `<Документ>`'s
 * `<ЗначенияРеквизитов>` carries zero or more `<ЗначениеРеквизита>`, the same
 * shape `<Товар>`/`<Предложение>`/`<Цена>` already have here.
 */
const REPEATING_TAGS = new Set([
  "Товар",
  "Предложение",
  "Цена",
  "ТипЦены",
  "Документ",
  "ЗначениеРеквизита",
]);
```

- [ ] **Step 2: Export the four helpers**

At `parse.ts:206`, change `function parseXml(bytes: Buffer): unknown {` to `export function parseXml(bytes: Buffer): unknown {`.

At `parse.ts:225`, change `function asObject(value: unknown): Record<string, unknown> {` to `export function asObject(value: unknown): Record<string, unknown> {`.

At `parse.ts:230`, change `function dig(root: unknown, ...path: string[]): Record<string, unknown> {` to `export function dig(root: unknown, ...path: string[]): Record<string, unknown> {`.

At `parse.ts:244`, change `function textOf(value: unknown): string {` to `export function textOf(value: unknown): string {`.

- [ ] **Step 3: Run the existing parse test suite to confirm nothing broke**

```bash
pnpm --filter @markiro/api exec vitest run test/commerceml-parse.test.ts
```

Expected: PASS (all existing tests, unchanged — this step only widens visibility).

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exchange/commerceml/parse.ts
git commit -m "refactor(api): export parse.ts's XML primitives for И-2's order-status parser"
```

---

## Task 4: Pure domain — outbound export planning + document building

**Files:**

- Create: `apps/api/src/modules/exchange/commerceml/order-export.ts`
- Create: `apps/api/test/commerceml-order-export.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks (pure, no DB).
- Produces: `planExport(orders: ExportCandidateOrder[]): ExportPlan`, `buildOrdersDocument(orders: EligibleOrder[], settings: OrderDocumentSettings): string`, plus the types `ExportCandidateOrder`, `ExportCandidateItem`, `EligibleOrder`, `HeldOrder`, `ExportPlan`, `OrderDocumentSettings` — consumed by Task 6 (`findExportCandidates` returns `ExportCandidateRow[]`, structurally compatible with `ExportCandidateOrder[]`) and Task 10 (`ExchangeController`'s `query()`).

- [ ] **Step 1: Write the file**

Create `apps/api/src/modules/exchange/commerceml/order-export.ts`:

```ts
/** One order eligible (or held) for outbound export -- see `planExport`. */
export interface ExportCandidateOrder {
  id: string;
  orderNo: string;
  createdAt: Date;
  reason: "buy" | "writeoff";
  writeoffReasonName: string | null;
  totalPrice: string | null;
  items: ExportCandidateItem[];
}

export interface ExportCandidateItem {
  productId: string;
  /** `products.external_ref` -- `null` means this product was never linked to a 1С GUID. */
  productExternalRef: string | null;
  unitPrice: string | null;
}

/** One line of a built order document -- one row per DISTINCT product, not per scanned unit (пикап-заявка не хранит per-line quantity). */
export interface OrderExportLine {
  externalRef: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

/** An order held back this round because at least one item's product has no 1С link yet (спека §5: "товар без связи придерживает заявку"). */
export interface HeldOrder {
  orderId: string;
  orderNo: string;
  unlinkedProductIds: string[];
}

export interface EligibleOrder {
  order: ExportCandidateOrder;
  lines: OrderExportLine[];
}

export interface ExportPlan {
  eligible: EligibleOrder[];
  held: HeldOrder[];
}

/**
 * Splits `orders` into what can go out this round and what is held back, per
 * spec §5 "Товар без связи придерживает заявку": an order with even ONE item
 * whose product carries no 1С `external_ref` cannot be expressed as a
 * CommerceML line (there is no GUID to write), and sending the order without
 * that line would silently under-report what was taken -- worse than not
 * sending it at all. `held` carries every unlinked product id so the caller
 * (`ExchangeController.query`, journal; `PickupOrdersService.detail`, admin
 * UI) can point at exactly what needs linking.
 */
export function planExport(orders: ExportCandidateOrder[]): ExportPlan {
  const eligible: EligibleOrder[] = [];
  const held: HeldOrder[] = [];

  for (const order of orders) {
    const unlinked = [
      ...new Set(
        order.items
          .filter((item) => item.productExternalRef === null)
          .map((item) => item.productId),
      ),
    ];
    if (unlinked.length > 0) {
      held.push({ orderId: order.id, orderNo: order.orderNo, unlinkedProductIds: unlinked });
      continue;
    }

    const byProduct = new Map<string, { quantity: number; unitPrice: string | null }>();
    for (const item of order.items) {
      const ref = item.productExternalRef!;
      const existing = byProduct.get(ref);
      if (existing) {
        existing.quantity += 1;
      } else {
        byProduct.set(ref, { quantity: 1, unitPrice: item.unitPrice });
      }
    }

    const lines: OrderExportLine[] = [...byProduct.entries()].map(([externalRef, group]) => {
      // One representative price per product, not a sum of per-scan
      // snapshots that could in principle drift within the same order: items
      // of the same product in the same pickup are scanned together and
      // share a price in practice, and this exchange tracks no price history
      // at all (спека §4.3) -- there is nothing finer to reconstruct here. A
      // `null` snapshot becomes "0.00" so the order still ships rather than
      // being dropped over one missing price; the order-level `<Сумма>`
      // below is the order's own STORED total, not recomputed from lines, so
      // it stays the authoritative figure regardless.
      const unitPrice = group.unitPrice ?? "0.00";
      return {
        externalRef,
        quantity: group.quantity,
        unitPrice,
        lineTotal: (Number(unitPrice) * group.quantity).toFixed(2),
      };
    });

    eligible.push({ order, lines });
  }

  return { eligible, held };
}

export interface OrderDocumentSettings {
  splitWriteoffDocument: boolean;
  writeoffDocumentType?: string | undefined;
}

const DEFAULT_DOCUMENT_TYPE = "Заказ товара";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD`, UTC -- `order.createdAt` is `timestamptz`; спека §5's "несёт createdAt -- время отбора" names no timezone of its own. */
function dateOf(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** `HH:MM:SS`, UTC -- see `dateOf`'s own comment. */
function timeOf(date: Date): string {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

/**
 * `&`/`<`/`>` are the only three characters that can break well-formedness
 * inside XML text content (`"`/`'` only matter inside attribute values, and
 * this document carries none -- every field here is an element, never an
 * attribute, matching `parse.ts`'s own `ignoreAttributes: true` reading
 * convention).
 */
function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tag(name: string, content: string): string {
  return `<${name}>${content}</${name}>`;
}

function buildDocumentXml(
  order: ExportCandidateOrder,
  lines: OrderExportLine[],
  settings: OrderDocumentSettings,
): string {
  const documentType =
    order.reason === "writeoff" && settings.splitWriteoffDocument && settings.writeoffDocumentType
      ? settings.writeoffDocumentType
      : DEFAULT_DOCUMENT_TYPE;
  const reasonComment =
    order.reason === "writeoff"
      ? order.writeoffReasonName
        ? `Списание: ${order.writeoffReasonName}`
        : "Списание"
      : "Продажа";

  const goodsXml = lines
    .map((line) =>
      tag(
        "Товар",
        [
          tag("Ид", escapeXmlText(line.externalRef)),
          tag("Количество", String(line.quantity)),
          tag("ЦенаЗаЕдиницу", line.unitPrice),
          tag("Сумма", line.lineTotal),
        ].join(""),
      ),
    )
    .join("");

  return tag(
    "Документ",
    [
      tag("Ид", escapeXmlText(order.id)),
      tag("Номер", escapeXmlText(order.orderNo)),
      tag("Дата", dateOf(order.createdAt)),
      tag("Время", timeOf(order.createdAt)),
      tag("ХозОперация", escapeXmlText(documentType)),
      tag("Валюта", "руб"),
      tag("Сумма", order.totalPrice ?? "0.00"),
      tag("Комментарий", escapeXmlText(reasonComment)),
      // Спека §5: причина дублируется отдельным реквизитом, который
      // конфигурация 1С может замапить -- тот же механизм `<ЗначенияРеквизитов>`
      // спека §6 использует для статуса в ОБРАТНУЮ сторону (order-status.ts).
      tag(
        "ЗначенияРеквизитов",
        tag(
          "ЗначениеРеквизита",
          [tag("Наименование", "ПричинаВыдачи"), tag("Значение", order.reason)].join(""),
        ),
      ),
      tag("Товары", goodsXml),
    ].join(""),
  );
}

/**
 * Builds the `<КоммерческаяИнформация><ПакетДокументов>` XML body
 * `mode=query` answers with (спека §5). Hand-rolled string concatenation, not
 * `fast-xml-parser`'s own `XMLBuilder`: that class is `@deprecated` in this
 * package's own types (5.10.1, `fxp.d.ts`) in favour of a SEPARATE
 * `fast-xml-builder` package, and every value going into this document comes
 * from THIS database -- never from the untrusted `/1c_exchange` caller (that
 * direction is `parse.ts`'s job) -- so there is no attacker-controlled input
 * here for a real builder library to guard against that `escapeXmlText`
 * doesn't already cover.
 */
export function buildOrdersDocument(
  orders: EligibleOrder[],
  settings: OrderDocumentSettings,
): string {
  const documentsXml = orders
    .map(({ order, lines }) => buildDocumentXml(order, lines, settings))
    .join("");
  const body = tag("КоммерческаяИнформация", tag("ПакетДокументов", documentsXml));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}
```

- [ ] **Step 2: Write the failing tests first**

Create `apps/api/test/commerceml-order-export.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildOrdersDocument,
  planExport,
  type ExportCandidateOrder,
} from "../src/modules/exchange/commerceml/order-export";

const baseOrder: ExportCandidateOrder = {
  id: "a1b2c3d4-0000-0000-0000-000000000001",
  orderNo: "ORD-26-0001",
  createdAt: new Date("2026-07-30T12:34:56.000Z"),
  reason: "buy",
  writeoffReasonName: null,
  totalPrice: "199.80",
  items: [
    { productId: "p1", productExternalRef: "ext-1", unitPrice: "99.90" },
    { productId: "p1", productExternalRef: "ext-1", unitPrice: "99.90" },
  ],
};

describe("commerceml order-export: planExport", () => {
  it("считает заявку с полностью связанными товарами пригодной к выгрузке", () => {
    const plan = planExport([baseOrder]);
    expect(plan.held).toEqual([]);
    expect(plan.eligible).toHaveLength(1);
    expect(plan.eligible[0]!.lines).toEqual([
      { externalRef: "ext-1", quantity: 2, unitPrice: "99.90", lineTotal: "199.80" },
    ]);
  });

  it("придерживает заявку с хотя бы одним не связанным товаром", () => {
    const held: ExportCandidateOrder = {
      ...baseOrder,
      items: [
        { productId: "p1", productExternalRef: "ext-1", unitPrice: "99.90" },
        { productId: "p2", productExternalRef: null, unitPrice: "50.00" },
      ],
    };
    const plan = planExport([held]);
    expect(plan.eligible).toEqual([]);
    expect(plan.held).toEqual([
      { orderId: held.id, orderNo: held.orderNo, unlinkedProductIds: ["p2"] },
    ]);
  });

  it("группирует по товару, а не по позиции", () => {
    const threeUnits: ExportCandidateOrder = {
      ...baseOrder,
      items: [
        { productId: "p1", productExternalRef: "ext-1", unitPrice: "10.00" },
        { productId: "p1", productExternalRef: "ext-1", unitPrice: "10.00" },
        { productId: "p1", productExternalRef: "ext-1", unitPrice: "10.00" },
      ],
    };
    const plan = planExport([threeUnits]);
    expect(plan.eligible[0]!.lines).toEqual([
      { externalRef: "ext-1", quantity: 3, unitPrice: "10.00", lineTotal: "30.00" },
    ]);
  });

  it("подставляет 0.00 вместо отсутствующего снимка цены, не роняя заявку", () => {
    const noPrice: ExportCandidateOrder = {
      ...baseOrder,
      items: [{ productId: "p1", productExternalRef: "ext-1", unitPrice: null }],
    };
    const plan = planExport([noPrice]);
    expect(plan.eligible[0]!.lines).toEqual([
      { externalRef: "ext-1", quantity: 1, unitPrice: "0.00", lineTotal: "0.00" },
    ]);
  });
});

describe("commerceml order-export: buildOrdersDocument", () => {
  it("строит документ с реквизитом причины и товарными строками", () => {
    const plan = planExport([baseOrder]);
    const xml = buildOrdersDocument(plan.eligible, { splitWriteoffDocument: false });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<Ид>a1b2c3d4-0000-0000-0000-000000000001</Ид>");
    expect(xml).toContain("<Номер>ORD-26-0001</Номер>");
    expect(xml).toContain("<Дата>2026-07-30</Дата>");
    expect(xml).toContain("<Время>12:34:56</Время>");
    expect(xml).toContain("<ХозОперация>Заказ товара</ХозОперация>");
    expect(xml).toContain("<Наименование>ПричинаВыдачи</Наименование><Значение>buy</Значение>");
    expect(xml).toContain("<Ид>ext-1</Ид><Количество>2</Количество>");
  });

  it("использует writeoffDocumentType только когда splitWriteoffDocument включён", () => {
    const writeoffOrder: ExportCandidateOrder = {
      ...baseOrder,
      reason: "writeoff",
      writeoffReasonName: "Порча",
    };
    const plan = planExport([writeoffOrder]);

    const notSplit = buildOrdersDocument(plan.eligible, { splitWriteoffDocument: false });
    expect(notSplit).toContain("<ХозОперация>Заказ товара</ХозОперация>");

    const split = buildOrdersDocument(plan.eligible, {
      splitWriteoffDocument: true,
      writeoffDocumentType: "Списание товара",
    });
    expect(split).toContain("<ХозОперация>Списание товара</ХозОперация>");
    expect(split).toContain("<Комментарий>Списание: Порча</Комментарий>");
  });

  it("экранирует & < > в текстовых полях", () => {
    const weirdOrder: ExportCandidateOrder = { ...baseOrder, orderNo: "A&B <test>" };
    const plan = planExport([weirdOrder]);
    const xml = buildOrdersDocument(plan.eligible, { splitWriteoffDocument: false });
    expect(xml).toContain("<Номер>A&amp;B &lt;test&gt;</Номер>");
  });

  it("пустой список заявок всё равно строит валидный пустой пакет", () => {
    const xml = buildOrdersDocument([], { splitWriteoffDocument: false });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<КоммерческаяИнформация><ПакетДокументов></ПакетДокументов></КоммерческаяИнформация>',
    );
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
pnpm --filter @markiro/api exec vitest run test/commerceml-order-export.test.ts
```

Expected: PASS (9 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/exchange/commerceml/order-export.ts apps/api/test/commerceml-order-export.test.ts
git commit -m "feat(api): add pure order-export planning and CommerceML document builder"
```

---

## Task 5: Pure domain — inbound order-status parsing + resolution

**Files:**

- Create: `apps/api/src/modules/exchange/commerceml/order-status.ts`
- Create: `apps/api/test/commerceml-order-status.test.ts`
- Create: `apps/api/test/fixtures/commerceml/sale-status.xml`

**Interfaces:**

- Consumes: `parseXml`, `asObject`, `dig`, `textOf` from `./parse` (Task 3).
- Produces: `parseOrderStatusDocuments(bytes, statusFieldName): ParsedOrderStatusDocument[]`, `resolveMappedStatus(statusValue, statusMapping): MappedOrderStatus | null`, and the type `MappedOrderStatus` — consumed by Task 12 (`ExchangeController.importOrderStatuses`).

- [ ] **Step 1: Write the fixture**

Create `apps/api/test/fixtures/commerceml/sale-status.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация>
  <ПакетДокументов>
    <Документ>
      <Ид>a1b2c3d4-0000-0000-0000-000000000001</Ид>
      <ЗначенияРеквизитов>
        <ЗначениеРеквизита>
          <Наименование>СтатусЗаказа</Наименование>
          <Значение>Оплачен</Значение>
        </ЗначениеРеквизита>
      </ЗначенияРеквизитов>
    </Документ>
    <Документ>
      <Ид>a1b2c3d4-0000-0000-0000-000000000002</Ид>
      <ЗначенияРеквизитов>
        <ЗначениеРеквизита>
          <Наименование>ДругойРеквизит</Наименование>
          <Значение>что-то</Значение>
        </ЗначениеРеквизита>
      </ЗначенияРеквизитов>
    </Документ>
    <Документ>
      <Ид>a1b2c3d4-0000-0000-0000-000000000003</Ид>
    </Документ>
  </ПакетДокументов>
</КоммерческаяИнформация>
```

(Three documents: one carrying the configured status requisite, one carrying a DIFFERENT requisite only, one carrying no `<ЗначенияРеквизитов>` at all.)

- [ ] **Step 2: Write the file**

Create `apps/api/src/modules/exchange/commerceml/order-status.ts`:

```ts
import { asObject, dig, parseXml, textOf } from "./parse";

export interface ParsedOrderStatusDocument {
  externalRef: string;
  /** `null` when this document carries no matching requisite, or none was configured to look for at all. */
  statusValue: string | null;
}

/**
 * Reads `<Документ>` entries off a `type=sale` file (спека §6, "Из 1С к нам")
 * -- 1С's own report of orders it knows changed, in the SAME
 * `<ЗначенияРеквизитов>` shape спека §5's outbound direction uses (a genuine
 * CommerceML mechanism for configuration-defined custom fields, not
 * something invented for this exchange). `statusFieldName` is this
 * connection's own answer to "what does THIS 1С configuration call its
 * status requisite" (`channel-registry.ts`'s `orderStatusField` setting) --
 * there is no standard name across configurations (спека §6), so an
 * unconfigured connection gets `statusValue: null` for every document, same
 * as one whose document genuinely carries no matching requisite.
 */
export function parseOrderStatusDocuments(
  bytes: Buffer,
  statusFieldName: string | undefined,
): ParsedOrderStatusDocument[] {
  const root = parseXml(bytes);
  const container = dig(root, "КоммерческаяИнформация", "ПакетДокументов");
  const rawDocuments = container["Документ"];
  return (Array.isArray(rawDocuments) ? rawDocuments : []).map((raw): ParsedOrderStatusDocument => {
    const document = asObject(raw);
    const externalRef = textOf(document["Ид"]);
    const rawValues = dig(document, "ЗначенияРеквизитов")["ЗначениеРеквизита"];
    const entries = Array.isArray(rawValues) ? rawValues : [];

    let statusValue: string | null = null;
    if (statusFieldName !== undefined) {
      for (const rawEntry of entries) {
        const entry = asObject(rawEntry);
        if (textOf(entry["Наименование"]) === statusFieldName) {
          statusValue = textOf(entry["Значение"]);
          break;
        }
      }
    }
    return { externalRef, statusValue };
  });
}

/** Statuses `PickupOrdersService.applyExternalStatus` can transition a `pending` order into -- never `pending` itself (спека §6). */
export type MappedOrderStatus = "punched" | "writtenoff" | "cancelled";

const MAPPED_STATUSES = new Set<MappedOrderStatus>(["punched", "writtenoff", "cancelled"]);

function isMappedOrderStatus(value: string): value is MappedOrderStatus {
  return MAPPED_STATUSES.has(value as MappedOrderStatus);
}

/**
 * Resolves one document's raw `statusValue` (from `parseOrderStatusDocuments`)
 * through the connection's own `statusMapping` table (спека §6: "данные, а не
 * код") into one of the three statuses `applyExternalStatus` can apply.
 * `null` covers every "cannot decide" case identically -- no value present in
 * the document, no mapping configured at all, or a value the table doesn't
 * list -- спека §6's "по умолчанию слой выключен: неизвестный внешний статус
 * не двигает заявку молча", so the caller journals all three the same way
 * ("статус не сопоставлен"), not as three different shapes.
 */
export function resolveMappedStatus(
  statusValue: string | null,
  statusMapping: Record<string, string> | undefined,
): MappedOrderStatus | null {
  if (statusValue === null || !statusMapping) return null;
  const mapped = statusMapping[statusValue];
  return mapped !== undefined && isMappedOrderStatus(mapped) ? mapped : null;
}
```

- [ ] **Step 3: Write the tests**

Create `apps/api/test/commerceml-order-status.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseOrderStatusDocuments,
  resolveMappedStatus,
} from "../src/modules/exchange/commerceml/order-status";

const fixture = readFileSync(join(__dirname, "fixtures/commerceml/sale-status.xml"));

describe("commerceml order-status: parseOrderStatusDocuments", () => {
  it("читает значение настроенного реквизита", () => {
    const docs = parseOrderStatusDocuments(fixture, "СтатусЗаказа");
    expect(docs[0]).toEqual({
      externalRef: "a1b2c3d4-0000-0000-0000-000000000001",
      statusValue: "Оплачен",
    });
  });

  it("отдаёт null, если документ несёт другой реквизит", () => {
    const docs = parseOrderStatusDocuments(fixture, "СтатусЗаказа");
    expect(docs[1]).toEqual({
      externalRef: "a1b2c3d4-0000-0000-0000-000000000002",
      statusValue: null,
    });
  });

  it("отдаёт null для документа без ЗначенияРеквизитов вообще", () => {
    const docs = parseOrderStatusDocuments(fixture, "СтатусЗаказа");
    expect(docs[2]).toEqual({
      externalRef: "a1b2c3d4-0000-0000-0000-000000000003",
      statusValue: null,
    });
  });

  it("отдаёт null для каждого документа, если реквизит не настроен вовсе", () => {
    const docs = parseOrderStatusDocuments(fixture, undefined);
    expect(docs.every((d) => d.statusValue === null)).toBe(true);
  });

  it("не падает на файле без документов", () => {
    const empty = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><КоммерческаяИнформация/>',
      "utf8",
    );
    expect(parseOrderStatusDocuments(empty, "СтатусЗаказа")).toEqual([]);
  });
});

describe("commerceml order-status: resolveMappedStatus", () => {
  const mapping = { Оплачен: "punched", Списан: "writtenoff", Отменён: "cancelled" };

  it("сопоставляет известное значение", () => {
    expect(resolveMappedStatus("Оплачен", mapping)).toBe("punched");
  });

  it("отдаёт null для неизвестного значения", () => {
    expect(resolveMappedStatus("Что-то ещё", mapping)).toBeNull();
  });

  it("отдаёт null, если значение отсутствует (null)", () => {
    expect(resolveMappedStatus(null, mapping)).toBeNull();
  });

  it("отдаёт null, если таблица сопоставления не задана", () => {
    expect(resolveMappedStatus("Оплачен", undefined)).toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @markiro/api exec vitest run test/commerceml-order-status.test.ts
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exchange/commerceml/order-status.ts apps/api/test/commerceml-order-status.test.ts apps/api/test/fixtures/commerceml/sale-status.xml
git commit -m "feat(api): add pure order-status document parser and mapping resolver"
```

---

## Task 6: `PickupOrdersService.findExportCandidates`

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/test/pickup-orders.e2e.test.ts`

**Interfaces:**

- Produces: `PickupOrdersService.findExportCandidates(tenantId: string, limit: number): Promise<ExportCandidateRow[]>`, where `ExportCandidateRow` is structurally `ExportCandidateOrder` from Task 4 — consumed by Task 10 (`ExchangeController.query`).

- [ ] **Step 1: Add the method**

In `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`, add this new public method right after `list()` (after line 412, before the `detail()` method):

```ts
  /** One row `findExportCandidates` hands to `order-export.ts`'s `planExport`. */

  /**
   * Orders eligible for `mode=query` this round: `pending`, never yet
   * exported (`exported_at is null`). Ordered oldest-first so a channel with
   * more pending orders than `limit` still makes steady progress across
   * rounds rather than the same newest batch crowding out the rest forever.
   * Items are fetched in a SECOND query (keyed on the same order ids) rather
   * than joined into the first, same shape `readJournal` already uses for
   * sessions + events (`integrations.service.ts`) -- an order-to-items join
   * would repeat every order column once per item row for no reason.
   */
  async findExportCandidates(
    tenantId: string,
    limit: number,
  ): Promise<
    {
      id: string;
      orderNo: string;
      createdAt: Date;
      reason: "buy" | "writeoff";
      writeoffReasonName: string | null;
      totalPrice: string | null;
      items: { productId: string; productExternalRef: string | null; unitPrice: string | null }[];
    }[]
  > {
    const orders = await this.db
      .select({
        id: schema.pickupOrders.id,
        orderNo: schema.pickupOrders.orderNo,
        createdAt: schema.pickupOrders.createdAt,
        reason: schema.pickupOrders.reason,
        writeoffReasonName: schema.pickupOrderReasons.name,
        totalPrice: schema.pickupOrders.totalPrice,
      })
      .from(schema.pickupOrders)
      .leftJoin(
        schema.pickupOrderReasons,
        eq(schema.pickupOrderReasons.id, schema.pickupOrders.writeoffReasonId),
      )
      .where(
        and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.status, "pending"),
          isNull(schema.pickupOrders.exportedAt),
        ),
      )
      .orderBy(asc(schema.pickupOrders.createdAt))
      .limit(limit);

    if (orders.length === 0) return [];

    const orderIds = orders.map((order) => order.id);
    const items = await this.db
      .select({
        orderId: schema.pickupOrderItems.orderId,
        productId: schema.pickupOrderItems.productId,
        productExternalRef: schema.products.externalRef,
        unitPrice: schema.pickupOrderItems.unitPrice,
      })
      .from(schema.pickupOrderItems)
      .innerJoin(schema.products, eq(schema.products.id, schema.pickupOrderItems.productId))
      .where(
        and(
          inArray(schema.pickupOrderItems.orderId, orderIds),
          eq(schema.pickupOrderItems.voided, false),
        ),
      );

    const itemsByOrder = new Map<
      string,
      { productId: string; productExternalRef: string | null; unitPrice: string | null }[]
    >();
    for (const item of items) {
      const entry = {
        productId: item.productId,
        productExternalRef: item.productExternalRef,
        unitPrice: item.unitPrice,
      };
      const bucket = itemsByOrder.get(item.orderId);
      if (bucket) bucket.push(entry);
      else itemsByOrder.set(item.orderId, [entry]);
    }

    return orders.map((order) => ({ ...order, items: itemsByOrder.get(order.id) ?? [] }));
  }
```

- [ ] **Step 2: Write the test**

In `apps/api/test/pickup-orders.e2e.test.ts`, add a new `it()` block inside the existing `describe.skipIf(!ready)("pickup orders admin e2e", ...)` block, near the other order-creation tests (this test needs its own `ref`/module instance to reach `PickupOrdersService` directly — reuse the SAME `ref` returned by the suite's own `Test.createTestingModule(...).compile()` call in `beforeAll`, by capturing it in an outer variable):

First, in `beforeAll`, change:

```ts
const ref = await Test.createTestingModule({
  imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
}).compile();
```

to capture `ref` in an outer-scoped variable (add `let ref: Awaited<ReturnType<typeof Test.createTestingModule>> extends never ? never : any;` is unnecessarily complex -- instead, just import `PickupOrdersService` and grab it right there):

```ts
const ref = await Test.createTestingModule({
  imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
}).compile();
pickupOrdersService = ref.get(PickupOrdersService);
```

Add the import at the top of the file:

```ts
import { PickupOrdersService } from "../src/modules/pickup-orders/pickup-orders.service";
```

Add the outer-scoped variable alongside the other `let` declarations near the top of the `describe` block (next to `let app: INestApplication | undefined;`):

```ts
let pickupOrdersService: PickupOrdersService;
```

Then add the test itself:

```ts
it("findExportCandidates отдаёт только pending и ещё не выгруженные заявки, с товарами", async () => {
  const linkedProductId = randomUUID();
  await db.insert(schema.products).values({
    id: linkedProductId,
    tenantId,
    gtin14: "04600682000037",
    name: "Товар со связью",
    externalRef: `ext-${randomUUID()}`,
  });

  const orderId = randomUUID();
  await db.insert(schema.pickupOrders).values({
    id: orderId,
    tenantId,
    orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
    kioskId,
    employeeId,
    reason: "buy",
    itemCount: 1,
    totalPrice: "10.00",
  });
  await db.insert(schema.pickupOrderItems).values({
    tenantId,
    orderId,
    productId: linkedProductId,
    gtin14: "04600682000037",
    serial: "SN0001",
    rawKm: "raw-export-1",
    kmKey: `kmkey-${randomUUID()}`,
    unitPrice: "10.00",
    scannedAt: new Date(),
  });

  const already = await pickupOrdersService.findExportCandidates(tenantId, 100);
  const found = already.find((o) => o.id === orderId);
  expect(found).toBeDefined();
  expect(found!.items).toEqual([
    { productId: linkedProductId, productExternalRef: expect.any(String), unitPrice: "10.00" },
  ]);

  await db
    .update(schema.pickupOrders)
    .set({ exportedAt: new Date() })
    .where(eq(schema.pickupOrders.id, orderId));
  const afterExport = await pickupOrdersService.findExportCandidates(tenantId, 100);
  expect(afterExport.some((o) => o.id === orderId)).toBe(false);
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-orders.e2e.test.ts
```

Expected: PASS (all existing tests plus this new one).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/test/pickup-orders.e2e.test.ts
git commit -m "feat(api): add PickupOrdersService.findExportCandidates for the И-2 outbound query"
```

---

## Task 7: `PickupOrdersService.applyExternalStatus`

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/test/pickup-orders.e2e.test.ts`

**Interfaces:**

- Produces: `PickupOrdersService.applyExternalStatus(tenantId, orderId, mappedStatus): Promise<ApplyExternalStatusResult>` — consumed by Task 12 (`ExchangeController.importOrderStatuses`).

- [ ] **Step 1: Add the type**

In `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`, immediately above `@Injectable()` / `export class PickupOrdersService {` (before line 69 — these type declarations live at module level, not inside the class body), add:

```ts
export type ApplyExternalStatusOutcome =
  "applied" | "not_found" | "not_pending" | "missing_writeoff_reason";

export interface ApplyExternalStatusResult {
  outcome: ApplyExternalStatusOutcome;
  currentStatus?: PickupOrderStatus;
}
```

This needs `PickupOrderStatus` added to the existing `import type { ... } from "./dto";` block at the top of the file (line 19-29) — add it to the list:

```ts
import type {
  CreateOrderDto,
  CreateOrderResultDto,
  KioskBootstrapDto,
  ListPickupOrdersQueryDto,
  ListPickupOrdersResponseDto,
  OrderConflict,
  PickupOrderDetailDto,
  PickupOrderRowDto,
  PickupOrderStatus,
  ResolvePickupOrderDto,
} from "./dto";
```

Then, inside the class, right after `cancel()` (after line 710, before `assertValidWriteoffReason`), add:

```ts
  /**
   * Applies a status 1С reported for this tenant's order via the CommerceML
   * `type=sale` reconciliation (спека §6, `order-status.ts`'s
   * `resolveMappedStatus`). Same guarded `pending -> X` transition
   * `resolve`/`cancel` above already enforce -- an order 1С reports as
   * changed, but this server no longer sees as `pending` (an admin already
   * resolved/cancelled it locally, or 1С already reported this exact change
   * before), is a discrepancy for the CALLER to journal, never a thrown
   * exception: one bad row inside a reconciliation batch must never abort
   * the rest of it (same discipline `commerceml/apply.ts` already follows
   * for a bad price).
   */
  async applyExternalStatus(
    tenantId: string,
    orderId: string,
    mappedStatus: "punched" | "writtenoff" | "cancelled",
  ): Promise<ApplyExternalStatusResult> {
    const current = await this.findRow(tenantId, orderId);
    if (!current) return { outcome: "not_found" };
    if (current.status !== "pending") {
      return { outcome: "not_pending", currentStatus: current.status };
    }

    const pendingCondition = and(
      eq(schema.pickupOrders.tenantId, tenantId),
      eq(schema.pickupOrders.id, orderId),
      eq(schema.pickupOrders.status, "pending"),
    );

    if (mappedStatus === "cancelled") {
      const cancelledId = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.pickupOrders)
          .set({ status: "cancelled" })
          .where(pendingCondition)
          .returning({ id: schema.pickupOrders.id });
        if (!row) return null;
        await tx
          .update(schema.pickupOrderItems)
          .set({ voided: true })
          .where(
            and(
              eq(schema.pickupOrderItems.tenantId, tenantId),
              eq(schema.pickupOrderItems.orderId, orderId),
            ),
          );
        return row.id;
      });
      return cancelledId ? { outcome: "applied" } : { outcome: "not_pending" };
    }

    if (mappedStatus === "writtenoff" && !current.writeoffReasonId) {
      return { outcome: "missing_writeoff_reason" };
    }

    const resolvedAt = new Date();
    const [row] = await this.db
      .update(schema.pickupOrders)
      .set(
        mappedStatus === "punched"
          ? { status: "punched", resolvedAt, resolvedByUserId: null }
          : { status: "writtenoff", resolvedAt, resolvedByUserId: null },
      )
      .where(pendingCondition)
      .returning({ id: schema.pickupOrders.id });

    return row ? { outcome: "applied" } : { outcome: "not_pending" };
  }
```

- [ ] **Step 2: Write the tests**

In `apps/api/test/pickup-orders.e2e.test.ts`, add three more `it()` blocks after the one from Task 6:

```ts
it("applyExternalStatus переводит pending заявку в punched", async () => {
  const orderId = randomUUID();
  await db.insert(schema.pickupOrders).values({
    id: orderId,
    tenantId,
    orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
    kioskId,
    employeeId,
    reason: "buy",
    itemCount: 1,
  });

  const result = await pickupOrdersService.applyExternalStatus(tenantId, orderId, "punched");
  expect(result).toEqual({ outcome: "applied" });

  const [row] = await db
    .select({ status: schema.pickupOrders.status })
    .from(schema.pickupOrders)
    .where(eq(schema.pickupOrders.id, orderId));
  expect(row?.status).toBe("punched");
});

it("applyExternalStatus отказывает расхождением, если заявка уже не pending", async () => {
  const orderId = randomUUID();
  await db.insert(schema.pickupOrders).values({
    id: orderId,
    tenantId,
    orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
    kioskId,
    employeeId,
    reason: "buy",
    itemCount: 1,
    status: "punched",
  });

  const result = await pickupOrdersService.applyExternalStatus(tenantId, orderId, "cancelled");
  expect(result).toEqual({ outcome: "not_pending", currentStatus: "punched" });

  const [row] = await db
    .select({ status: schema.pickupOrders.status })
    .from(schema.pickupOrders)
    .where(eq(schema.pickupOrders.id, orderId));
  expect(row?.status).toBe("punched");
});

it("applyExternalStatus отказывает списанием без причины", async () => {
  const orderId = randomUUID();
  await db.insert(schema.pickupOrders).values({
    id: orderId,
    tenantId,
    orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
    kioskId,
    employeeId,
    reason: "buy",
    itemCount: 1,
  });

  const result = await pickupOrdersService.applyExternalStatus(tenantId, orderId, "writtenoff");
  expect(result).toEqual({ outcome: "missing_writeoff_reason" });
});

it("applyExternalStatus отдаёт not_found для чужого/несуществующего id", async () => {
  const result = await pickupOrdersService.applyExternalStatus(tenantId, randomUUID(), "punched");
  expect(result).toEqual({ outcome: "not_found" });
});
```

- [ ] **Step 3: Run the tests**

```bash
pnpm --filter @markiro/api exec vitest run test/pickup-orders.e2e.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/test/pickup-orders.e2e.test.ts
git commit -m "feat(api): add PickupOrdersService.applyExternalStatus for И-2 status reconciliation"
```

---

## Task 8: `ExchangeSessionService` — queried-order-ids bookkeeping

**Files:**

- Modify: `apps/api/src/modules/exchange/exchange-session.service.ts`
- Create: `apps/api/test/exchange-session.test.ts` (a small unit-style test may already not exist for this service; create it if absent, following the same real-DB pattern as other e2e tests here)

**Interfaces:**

- Produces: `ExchangeSessionService.writeQueriedOrderIds(sessionId, orderIds): Promise<void>`, `ExchangeSessionService.readQueriedOrderIds(sessionId): Promise<string[]>` — consumed by Task 10 (`query`) and Task 11 (`success`).

- [ ] **Step 1: Add the two methods**

In `apps/api/src/modules/exchange/exchange-session.service.ts`, add right after `writeImportCursor` (after line 305, before `sweepExpired`):

```ts
  /**
   * Records which order ids `mode=query` just offered, in THIS session's
   * `summary` -- same piggyback `readImportCursor`/`writeImportCursor` above
   * already use (a live session's `summary` is write-only scratch space
   * until `finishSession` sets the terminal one; see those methods' own
   * comment). `mode=success` (спека §5: "подтверждение до пометки") reads
   * this back to know exactly which orders THIS round's query covered,
   * without trusting whatever 1С's own success call happens to say.
   */
  async writeQueriedOrderIds(sessionId: string, orderIds: string[]): Promise<void> {
    const [row] = await this.db
      .select({ summary: schema.integrationSessions.summary })
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.id, sessionId));
    const summary = { ...(row?.summary ?? {}) };
    summary["queriedOrderIds"] = orderIds;
    await this.db
      .update(schema.integrationSessions)
      .set({ summary })
      .where(eq(schema.integrationSessions.id, sessionId));
  }

  /** Reads back what `writeQueriedOrderIds` last recorded for `sessionId`; `[]` if nothing was ever written. */
  async readQueriedOrderIds(sessionId: string): Promise<string[]> {
    const [row] = await this.db
      .select({ summary: schema.integrationSessions.summary })
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.id, sessionId));
    return (row?.summary?.["queriedOrderIds"] as string[] | undefined) ?? [];
  }
```

- [ ] **Step 2: No dedicated test file for this task**

`ExchangeSessionService` has no standalone test file today (confirmed: `find apps/api/test -iname "exchange-session*"` returns nothing) — its existing methods (`open`, `resolve`, `appendChunk`, etc.) are only ever exercised indirectly through `exchange-protocol.e2e.test.ts`'s HTTP-level tests. Follow the same convention here: this task's own coverage comes from Task 13's e2e test (the full `query`/`success` cycle exercises `writeQueriedOrderIds`/`readQueriedOrderIds` indirectly) rather than a new standalone unit test file.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/exchange/exchange-session.service.ts
git commit -m "feat(api): add queried-order-id bookkeeping to ExchangeSessionService"
```

---

## Task 9: Wire `PickupOrdersModule` into `ExchangeModule`

**Files:**

- Modify: `apps/api/src/modules/exchange/exchange.module.ts`
- Modify: `apps/api/src/modules/exchange/exchange.controller.ts` (constructor only)

**Interfaces:**

- Produces: `ExchangeController` now has `private readonly pickupOrders: PickupOrdersService` available — consumed by Task 10/12.

- [ ] **Step 1: Import the module**

In `apps/api/src/modules/exchange/exchange.module.ts`, add the import at the top:

```ts
import { PickupOrdersModule } from "../pickup-orders/pickup-orders.module";
```

And change the `@Module` decorator (lines 279-287):

```ts
@Module({
  imports: [PickupOrdersModule],
  controllers: [ExchangeController],
  providers: [
    ExchangeSessionService,
    JournalService,
    ExchangeChunkLimitMiddleware,
    ExchangeRawBodyMiddleware,
  ],
})
export class ExchangeModule implements NestModule {
```

- [ ] **Step 2: Inject the service into the controller**

In `apps/api/src/modules/exchange/exchange.controller.ts`, add the import:

```ts
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";
```

And change the constructor (lines 199-203):

```ts
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessions: ExchangeSessionService,
    private readonly journal: JournalService,
    private readonly pickupOrders: PickupOrdersService,
  ) {}
```

- [ ] **Step 3: Typecheck and run the existing exchange test suite**

```bash
pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit
pnpm --filter @markiro/api exec vitest run test/exchange-protocol.e2e.test.ts test/exchange-credentials.e2e.test.ts
```

Expected: no type errors; existing tests still PASS (this task only wires a new, still-unused dependency).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/exchange/exchange.module.ts apps/api/src/modules/exchange/exchange.controller.ts
git commit -m "feat(api): wire PickupOrdersModule into ExchangeModule for И-2"
```

---

## Task 10: Wire `mode=query` (GET)

**Files:**

- Modify: `apps/api/src/modules/exchange/exchange.controller.ts`

**Interfaces:**

- Consumes: `planExport`, `buildOrdersDocument`, `EligibleOrder` from `./commerceml/order-export` (Task 4); `PickupOrdersService.findExportCandidates` (Task 6); `ExchangeSessionService.writeQueriedOrderIds` (Task 8).

- [ ] **Step 1: Add the import and the batch-size constant**

At the top of `exchange.controller.ts`, add:

```ts
import { buildOrdersDocument, planExport } from "./commerceml/order-export";
```

Right after `IMPORT_BATCH_SIZE`'s declaration (after line 50), add:

```ts
/**
 * Ceiling on how many orders `mode=query` offers in one round -- spec §5's
 * outbound direction, mirroring `IMPORT_BATCH_SIZE`'s own reasoning: an order
 * document is heavier than a single price row, so this batch is smaller.
 * Picked comfortably larger than any fixture in this test suite; not tuned
 * against a real large backlog yet.
 */
export const EXPORT_BATCH_SIZE = 200;
```

- [ ] **Step 2: Add the `mode=query` branch in `get()`**

In `get()`, right after the `if (mode === "import") { ... }` block (after line 271, before `await this.unknownMode(session, mode);`), add:

```ts
if (mode === "query") {
  await this.query(session, res);
  return;
}
```

- [ ] **Step 3: Add the `query` method**

Add this new private method right after `applyWorkItem` (after line 748, before `unknownMode`):

```ts
  /**
   * `mode=query`: спека §5's outbound direction. Builds this round's
   * eligible-order document (Task 4's `planExport`/`buildOrdersDocument`),
   * remembers which order ids it just offered (Task 8's
   * `writeQueriedOrderIds` -- `mode=success` reads this back rather than
   * trusting whatever 1С's own confirmation happens to say), and journals a
   * held-order warning for every order this round is NOT offering because a
   * product still lacks a 1С link (спека §5: "товар без связи придерживает
   * заявку").
   */
  private async query(session: ResolvedExchangeSession, res: Response): Promise<void> {
    const candidates = await this.pickupOrders.findExportCandidates(session.tenantId, EXPORT_BATCH_SIZE);
    const plan = planExport(candidates);

    for (const held of plan.held) {
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "out",
        outcome: "warn",
        grain: "item",
        message: `заявка придержана — товар без связи с 1С: ${held.orderNo}`,
        details: { orderId: held.orderId, orderNo: held.orderNo, unlinkedProductIds: held.unlinkedProductIds },
      });
    }

    const [channelRow] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, session.tenantId),
          eq(schema.integrationChannels.type, session.channelType),
        ),
      );
    const settings = (channelRow?.settings ?? {}) as {
      splitWriteoffDocument?: boolean;
      writeoffDocumentType?: string;
    };

    const xml = buildOrdersDocument(plan.eligible, {
      splitWriteoffDocument: settings.splitWriteoffDocument ?? false,
      writeoffDocumentType: settings.writeoffDocumentType,
    });

    await this.sessions.writeQueriedOrderIds(
      session.id,
      plan.eligible.map((eligible) => eligible.order.id),
    );

    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "out",
      outcome: "ok",
      grain: "session",
      message: `query: предложено заявок: ${plan.eligible.length}`,
      details: { offered: plan.eligible.length, held: plan.held.length },
    });

    res.status(200).type("application/xml").send(xml);
  }
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exchange/exchange.controller.ts
git commit -m "feat(api): wire mode=query — outbound order export over CommerceML"
```

---

## Task 11: Wire `mode=success` (POST)

**Files:**

- Modify: `apps/api/src/modules/exchange/exchange.controller.ts`

**Interfaces:**

- Consumes: `ExchangeSessionService.readQueriedOrderIds`/`writeQueriedOrderIds` (Task 8).

- [ ] **Step 1: Add the `mode=success` branch in `post()`**

In `post()`, right after the `mode === "file"` block (after line 335, before `await this.unknownMode(session, mode);`), add:

```ts
if (mode === "success") {
  await this.success(session, res);
  return;
}
```

- [ ] **Step 2: Add the `success` method**

Add this new private method right after `query` (from Task 10):

```ts
  /**
   * `mode=success`: спека §5's "подтверждение до пометки" -- marks EXACTLY
   * the order ids the immediately preceding `mode=query` on THIS session
   * offered (Task 8's `readQueriedOrderIds`, not whatever 1С's own success
   * call happens to say) as exported, and only those still `pending` with no
   * `exportedAt` yet -- a race with a manual admin resolve/cancel in between
   * is harmless either way (the order is already terminal, or already
   * exported by a concurrent success call). Clears the recorded ids after,
   * so a stray extra `mode=success` with nothing pending confirms zero.
   */
  private async success(session: ResolvedExchangeSession, res: Response): Promise<void> {
    const orderIds = await this.sessions.readQueriedOrderIds(session.id);
    let confirmed = 0;

    if (orderIds.length > 0) {
      const updated = await this.db
        .update(schema.pickupOrders)
        .set({ exportedAt: new Date() })
        .where(
          and(
            eq(schema.pickupOrders.tenantId, session.tenantId),
            inArray(schema.pickupOrders.id, orderIds),
            eq(schema.pickupOrders.status, "pending"),
            isNull(schema.pickupOrders.exportedAt),
          ),
        )
        .returning({ id: schema.pickupOrders.id });
      confirmed = updated.length;
      await this.sessions.writeQueriedOrderIds(session.id, []);
    }

    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "out",
      outcome: "ok",
      grain: "session",
      message: `success: подтверждено заявок: ${confirmed}`,
      details: { confirmed, offered: orderIds.length },
    });

    this.text(res, "success");
  }
```

- [ ] **Step 3: Add the missing import**

`success()` above needs both `isNull` and `inArray`, neither imported yet — the current import line reads `import { and, eq, isNotNull } from "drizzle-orm";`. Change it to:

```ts
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/exchange/exchange.controller.ts
git commit -m "feat(api): wire mode=success — confirms exported orders over CommerceML"
```

---

## Task 12: Wire `type=sale` on `mode=file`/`mode=import`

**Files:**

- Modify: `apps/api/src/modules/exchange/exchange.controller.ts`

**Interfaces:**

- Consumes: `parseOrderStatusDocuments`, `resolveMappedStatus` from `./commerceml/order-status` (Task 5); `PickupOrdersService.applyExternalStatus` (Task 7).

- [ ] **Step 1: Add the import**

```ts
import { parseOrderStatusDocuments, resolveMappedStatus } from "./commerceml/order-status";
```

- [ ] **Step 2: Thread `type` into `import()`**

In `get()`'s `mode === "import"` branch (line 268-271), change:

```ts
if (mode === "import") {
  await this.import(session, filename, res);
  return;
}
```

to:

```ts
if (mode === "import") {
  await this.import(session, type, filename, res);
  return;
}
```

Change `import()`'s signature (line 479-483) from:

```ts
  private async import(
    session: ResolvedExchangeSession,
    filename: string | undefined,
    res: Response,
  ): Promise<void> {
```

to:

```ts
  private async import(
    session: ResolvedExchangeSession,
    type: string | undefined,
    filename: string | undefined,
    res: Response,
  ): Promise<void> {
```

- [ ] **Step 3: Branch to the order-status path**

Inside `import()`, right after `const bytes = await this.sessions.assemble(session.id, filename);` (line 499), add:

```ts
if (type === "sale") {
  await this.importOrderStatuses(session, filename, bytes, res);
  return;
}
```

(The rest of `import()` — parsing catalog/offers via `parseCommerceMl` — stays exactly as it is, for the default/`type=catalog` case.)

- [ ] **Step 4: Add the `importOrderStatuses` method**

Add this new private method right after `import()` (after line 702, before `applyWorkItem`):

```ts
  /**
   * `type=sale&mode=import` -- спека §6, "Из 1С к нам". Reads changed-order
   * documents 1С reports (Task 5's `parseOrderStatusDocuments`) and, for
   * each, resolves its own status requisite through this connection's
   * `statusMapping` (Task 5's `resolveMappedStatus`) into one of the three
   * transitions `PickupOrdersService.applyExternalStatus` (Task 7) can
   * apply. One row's outcome never aborts the round -- same discipline
   * `apply.ts`'s price decisions already follow.
   */
  private async importOrderStatuses(
    session: ResolvedExchangeSession,
    filename: string,
    bytes: Buffer,
    res: Response,
  ): Promise<void> {
    const [channelRow] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, session.tenantId),
          eq(schema.integrationChannels.type, session.channelType),
        ),
      );
    const settings = (channelRow?.settings ?? {}) as {
      orderStatusField?: string;
      statusMapping?: Record<string, string>;
    };

    let documents: ReturnType<typeof parseOrderStatusDocuments>;
    try {
      documents = parseOrderStatusDocuments(bytes, settings.orderStatusField);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "error",
        grain: "session",
        message: `import (sale): ${detail}`,
        details: { filename, raw: rawFailureBody(IMPORT_PARSE_FAILURE) },
      });
      this.fail(res, IMPORT_PARSE_FAILURE);
      return;
    }

    let applied = 0;
    let discrepancies = 0;
    for (const document of documents) {
      const mapped = resolveMappedStatus(document.statusValue, settings.statusMapping);
      if (mapped === null) {
        discrepancies++;
        await this.journal.append({
          tenantId: session.tenantId,
          channelType: session.channelType,
          sessionId: session.id,
          direction: "in",
          outcome: "warn",
          grain: "item",
          message: `статус не сопоставлен: ${document.externalRef}`,
          details: { externalRef: document.externalRef, statusValue: document.statusValue },
        });
        continue;
      }

      const result = await this.pickupOrders.applyExternalStatus(
        session.tenantId,
        document.externalRef,
        mapped,
      );
      if (result.outcome === "applied") {
        applied++;
        continue;
      }
      discrepancies++;
      await this.journal.append({
        tenantId: session.tenantId,
        channelType: session.channelType,
        sessionId: session.id,
        direction: "in",
        outcome: "warn",
        grain: "item",
        message: `расхождение статуса (${result.outcome}): ${document.externalRef} -> ${mapped}`,
        details: { externalRef: document.externalRef, mapped, outcome: result.outcome },
      });
    }

    await this.journal.append({
      tenantId: session.tenantId,
      channelType: session.channelType,
      sessionId: session.id,
      direction: "in",
      outcome: "ok",
      grain: "session",
      message: `import (sale): файл «${filename}» применён`,
      details: { filename, applied, discrepancies, total: documents.length },
    });
    this.text(res, "success");
  }
```

- [ ] **Step 5: Typecheck and run existing exchange tests**

```bash
pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit
pnpm --filter @markiro/api exec vitest run test/exchange-protocol.e2e.test.ts test/exchange-import.e2e.test.ts
```

Expected: no type errors; existing catalog-import tests unaffected (default `type` still routes to the unchanged catalog path).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/exchange/exchange.controller.ts
git commit -m "feat(api): wire type=sale on mode=import — inbound order-status reconciliation"
```

---

## Task 13: e2e — new self-contained suite + full outbound export cycle

**Files:**

- Create: `apps/api/test/exchange-orders.e2e.test.ts`

**Interfaces:**

- Exercises Tasks 4, 6, 8, 9, 10 end-to-end over real HTTP + real Postgres.
- Deliberately a NEW file rather than an addition to `exchange-protocol.e2e.test.ts`: that file's fixtures cover only the catalog/checkauth/session mechanics (no kiosk/employee/pickup-order rows at all), and bolting pickup-order-domain setup onto it would blur that file's one clear responsibility. This suite sets up its own tenant, kiosk, and employee from scratch, the same way `pickup-orders.e2e.test.ts`'s `beforeAll` does.

- [ ] **Step 1: Write the file**

Create `apps/api/test/exchange-orders.e2e.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";
import { excludeExchangeRoute } from "../src/modules/exchange/exchange.module";
import { checkauthWindowStart } from "../src/modules/exchange/exchange-credentials";

describe("1c_exchange orders (И-2)", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let tenantId: string;
  let kioskId: string;
  let employeeId: string;
  let login: string;
  let secret: string;
  // Same reasoning as exchange-protocol.e2e.test.ts's own `checkauthWindow`:
  // captured once, at suite start, so afterAll's cleanup only ever removes
  // rate-limit rows this run itself could have written.
  const checkauthWindow = checkauthWindowStart(new Date());

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(excludeExchangeRoute(express.json()));
    await app.init();
    await listenOnLoopback(app);
    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    employeeId = randomUUID();
    await db.insert(schema.employees).values({ id: employeeId, tenantId, fullName: "Иван Иванов" });

    kioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId, name: "Киоск", dayLimitPerEmployee: 20 });

    const issued = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
    login = issued.body.login;
    secret = issued.body.secret;
  });

  afterAll(async () => {
    await db
      .delete(schema.exchangeAttempts)
      .where(
        and(
          inArray(schema.exchangeAttempts.source, ["127.0.0.1", "::1", "::ffff:127.0.0.1"]),
          eq(schema.exchangeAttempts.windowStartedAt, checkauthWindow),
        ),
      );
    await app?.close();
  });

  async function checkauth(): Promise<{ cookie: string }> {
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(login, secret)
      .expect(200);
    const [, name, value] = res.text.split("\n");
    return { cookie: `${name}=${value}` };
  }

  async function journalEvents(): Promise<
    { message: string; details: Record<string, unknown> | null }[]
  > {
    const res = await agent.get("/integrations/commerceml/journal").expect(200);
    return res.body.sessions.flatMap(
      (s: { events: { message: string; details: Record<string, unknown> | null }[] }) => s.events,
    );
  }

  it("query/success выгружает pending заявку и помечает её выгруженной", async () => {
    const { cookie } = await checkauth();

    const linkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: linkedProductId,
      tenantId,
      gtin14: "04600682000112",
      name: "Экспортный товар",
      externalRef: `ext-${randomUUID()}`,
    });

    const orderId = randomUUID();
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      totalPrice: "50.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId,
      productId: linkedProductId,
      gtin14: "04600682000112",
      serial: "SN9001",
      rawKm: "raw-query-1",
      kmKey: `kmkey-${randomUUID()}`,
      unitPrice: "50.00",
      scannedAt: new Date(),
    });

    const queryRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", cookie)
      .expect(200);
    expect(queryRes.headers["content-type"]).toContain("application/xml");
    expect(queryRes.text).toContain(`<Ид>${orderId}</Ид>`);

    const [beforeSuccess] = await db
      .select({ exportedAt: schema.pickupOrders.exportedAt })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(beforeSuccess?.exportedAt).toBeNull();

    const successRes = await request(app!.getHttpServer())
      .post("/1c_exchange?mode=success")
      .set("Cookie", cookie)
      .expect(200);
    expect(successRes.text).toBe("success");

    const [afterSuccess] = await db
      .select({ exportedAt: schema.pickupOrders.exportedAt })
      .from(schema.pickupOrders)
      .where(eq(schema.pickupOrders.id, orderId));
    expect(afterSuccess?.exportedAt).not.toBeNull();

    // A second query round must not offer the same order again.
    const secondQueryRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", cookie)
      .expect(200);
    expect(secondQueryRes.text).not.toContain(`<Ид>${orderId}</Ид>`);
  });

  it("товар без связи придерживает заявку — она не появляется в query", async () => {
    const { cookie } = await checkauth();

    const unlinkedProductId = randomUUID();
    await db.insert(schema.products).values({
      id: unlinkedProductId,
      tenantId,
      gtin14: "04600682000129",
      name: "Без связи",
    });

    const orderId = randomUUID();
    const orderNo = `ORD-26-${randomUUID().slice(0, 4)}`;
    await db.insert(schema.pickupOrders).values({
      id: orderId,
      tenantId,
      orderNo,
      kioskId,
      employeeId,
      reason: "buy",
      itemCount: 1,
      totalPrice: "10.00",
    });
    await db.insert(schema.pickupOrderItems).values({
      tenantId,
      orderId,
      productId: unlinkedProductId,
      gtin14: "04600682000129",
      serial: "SN9002",
      rawKm: "raw-query-2",
      kmKey: `kmkey-${randomUUID()}`,
      unitPrice: "10.00",
      scannedAt: new Date(),
    });

    const queryRes = await request(app!.getHttpServer())
      .get("/1c_exchange?mode=query")
      .set("Cookie", cookie)
      .expect(200);
    expect(queryRes.text).not.toContain(`<Ид>${orderId}</Ид>`);

    const events = await journalEvents();
    expect(events.some((e) => e.message.includes(orderNo))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @markiro/api exec vitest run test/exchange-orders.e2e.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/exchange-orders.e2e.test.ts
git commit -m "test(api): cover the full query/success outbound export cycle"
```

---

## Task 14: e2e — full inbound status reconciliation cycle

**Files:**

- Modify: `apps/api/test/exchange-orders.e2e.test.ts` (from Task 13)

**Interfaces:**

- Exercises Tasks 5, 7, 12 end-to-end over real HTTP + real Postgres, including the `mode=file` chunked-upload path.

- [ ] **Step 1: Add the tests**

Add these two `it()` blocks inside the same `describe("1c_exchange orders (И-2)", ...)` block from Task 13, right before its closing `});`:

```ts
it("type=sale&mode=import переводит pending заявку по сопоставленному статусу", async () => {
  const { cookie } = await checkauth();

  const orderId = randomUUID();
  await db.insert(schema.pickupOrders).values({
    id: orderId,
    tenantId,
    orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
    kioskId,
    employeeId,
    reason: "buy",
    itemCount: 1,
  });

  // Configure this connection's orderStatusField/statusMapping before
  // sending the file -- PATCH /integrations/commerceml with the admin
  // agent (this file's `agent`, distinct from the raw `request(...)` calls
  // used for `/1c_exchange` itself).
  await agent
    .patch("/integrations/commerceml")
    .send({ orderStatusField: "СтатусЗаказа", statusMapping: { Оплачен: "punched" } })
    .expect(200);

  const saleXml = Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<КоммерческаяИнформация><ПакетДокументов><Документ>",
      `<Ид>${orderId}</Ид>`,
      "<ЗначенияРеквизитов><ЗначениеРеквизита>",
      "<Наименование>СтатусЗаказа</Наименование><Значение>Оплачен</Значение>",
      "</ЗначениеРеквизита></ЗначенияРеквизитов>",
      "</Документ></ПакетДокументов></КоммерческаяИнформация>",
    ].join(""),
    "utf8",
  );

  // No explicit Content-Type header, matching every other `mode=file` test
  // in this codebase: `ensureContentType` (exchange.module.ts) backfills
  // one when absent, and supertest's `.send(Buffer)` doesn't set one on
  // its own -- see exchange-protocol.e2e.test.ts's own chunk-upload test.
  await request(app!.getHttpServer())
    .post("/1c_exchange?mode=file&filename=sale.xml")
    .set("Cookie", cookie)
    .send(saleXml)
    .expect(200);

  const importRes = await request(app!.getHttpServer())
    .get("/1c_exchange?mode=import&type=sale&filename=sale.xml")
    .set("Cookie", cookie)
    .expect(200);
  expect(importRes.text).toBe("success");

  const [row] = await db
    .select({ status: schema.pickupOrders.status })
    .from(schema.pickupOrders)
    .where(eq(schema.pickupOrders.id, orderId));
  expect(row?.status).toBe("punched");
});

it("статус, не найденный в таблице сопоставления, журналируется как расхождение и заявку не трогает", async () => {
  const { cookie } = await checkauth();

  const orderId = randomUUID();
  await db.insert(schema.pickupOrders).values({
    id: orderId,
    tenantId,
    orderNo: `ORD-26-${randomUUID().slice(0, 4)}`,
    kioskId,
    employeeId,
    reason: "buy",
    itemCount: 1,
  });

  const saleXml = Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<КоммерческаяИнформация><ПакетДокументов><Документ>",
      `<Ид>${orderId}</Ид>`,
      "<ЗначенияРеквизитов><ЗначениеРеквизита>",
      "<Наименование>СтатусЗаказа</Наименование><Значение>НеизвестноеЗначение</Значение>",
      "</ЗначениеРеквизита></ЗначенияРеквизитов>",
      "</Документ></ПакетДокументов></КоммерческаяИнформация>",
    ].join(""),
    "utf8",
  );

  await request(app!.getHttpServer())
    .post("/1c_exchange?mode=file&filename=sale2.xml")
    .set("Cookie", cookie)
    .send(saleXml)
    .expect(200);

  await request(app!.getHttpServer())
    .get("/1c_exchange?mode=import&type=sale&filename=sale2.xml")
    .set("Cookie", cookie)
    .expect(200);

  const [row] = await db
    .select({ status: schema.pickupOrders.status })
    .from(schema.pickupOrders)
    .where(eq(schema.pickupOrders.id, orderId));
  expect(row?.status).toBe("pending");

  const events = await journalEvents();
  expect(events.some((e) => e.message.startsWith("статус не сопоставлен"))).toBe(true);
});
```

- [ ] **Step 2: Run the tests**

```bash
pnpm --filter @markiro/api exec vitest run test/exchange-orders.e2e.test.ts
```

Expected: PASS (4 tests total).

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/exchange-orders.e2e.test.ts
git commit -m "test(api): cover inbound order-status reconciliation, mapped and unmapped"
```

---

## Task 15: Admin — export/held indicator + settings UI

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/dto.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/admin/src/pages/pickup/api.ts`
- Modify: `apps/admin/src/pages/pickup/OrderDetail.tsx`
- Modify: `apps/admin/src/pages/integrations/ChannelPage.tsx`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`

**Interfaces:**

- Produces: `PickupOrderRowDto.exportedAt: string | null`, `PickupOrderDetailDto.exportHeldProductNames: string[]`, mirrored client-side; `ChannelPage`'s CommerceML settings form gains `orderStatusField`, `writeoffDocumentType`, and a `statusMapping` key/value editor.

- [ ] **Step 1: Server DTOs**

In `apps/api/src/modules/pickup-orders/dto.ts`, add `exportedAt` to `PickupOrderRowDto` (right after `createdAt: Date;`, line 206):

```ts
export interface PickupOrderRowDto {
  id: string;
  orderNo: string;
  employeeName: string;
  kioskName: string;
  reason: "buy" | "writeoff";
  writeoffReasonName: string | null;
  itemCount: number;
  totalPrice: string | null;
  status: PickupOrderStatus;
  createdAt: Date;
  /** Set once 1С confirms receipt over `/1c_exchange` `mode=success` (плана И-2). `null` — not yet exported. */
  exportedAt: Date | null;
  /** How many scanned codes the server refused when this order synced. */
  conflictCount: number;
}
```

Add `exportHeldProductNames` to `PickupOrderDetailDto` (line 227-233):

```ts
export interface PickupOrderDetailDto extends PickupOrderRowDto {
  employeeBadgeCode: string | null;
  items: PickupOrderItemDto[];
  receiptNo: string | null;
  actNo: string | null;
  syncConflicts: OrderConflict[];
  /** Products this order's items reference that carry no 1С link yet — non-empty means this order is held back from `mode=query` (плана И-2, спека §5). */
  exportHeldProductNames: string[];
}
```

- [ ] **Step 2: Server mapping**

In `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`:

`joinedSelection()` (currently returns the object literal used by both `list` and `detail` — add `exportedAt`):

```ts
  private joinedSelection() {
    return {
      id: schema.pickupOrders.id,
      orderNo: schema.pickupOrders.orderNo,
      employeeName: schema.employees.fullName,
      kioskName: schema.kiosks.name,
      reason: schema.pickupOrders.reason,
      writeoffReasonName: schema.pickupOrderReasons.name,
      itemCount: schema.pickupOrders.itemCount,
      totalPrice: schema.pickupOrders.totalPrice,
      status: schema.pickupOrders.status,
      createdAt: schema.pickupOrders.createdAt,
      exportedAt: schema.pickupOrders.exportedAt,
      syncConflicts: schema.pickupOrders.syncConflicts,
    };
  }
```

`mapRowDto`'s row parameter type and return value — add `exportedAt`:

```ts
  private mapRowDto(row: {
    id: string;
    orderNo: string;
    employeeName: string | null;
    kioskName: string | null;
    reason: "buy" | "writeoff";
    writeoffReasonName: string | null;
    itemCount: number;
    totalPrice: string | null;
    status: "pending" | "punched" | "writtenoff" | "cancelled";
    createdAt: Date;
    exportedAt: Date | null;
    syncConflicts: { rawKm: string; reason: string }[] | null;
  }): PickupOrderRowDto {
    return {
      id: row.id,
      orderNo: row.orderNo,
      employeeName: row.employeeName ?? "",
      kioskName: row.kioskName ?? "",
      reason: row.reason,
      writeoffReasonName: row.writeoffReasonName,
      itemCount: row.itemCount,
      totalPrice: row.totalPrice,
      status: row.status,
      createdAt: row.createdAt,
      exportedAt: row.exportedAt,
      conflictCount: row.syncConflicts?.length ?? 0,
    };
  }
```

`detail()`'s item query — add `externalRef` so the held-product-names computation needs no second query, and build `exportHeldProductNames` before the return. Change the `itemRows` select (lines 445-461) to add `externalRef: schema.products.externalRef,`:

```ts
const itemRows = await this.db
  .select({
    id: schema.pickupOrderItems.id,
    gtin14: schema.pickupOrderItems.gtin14,
    serial: schema.pickupOrderItems.serial,
    rawKm: schema.pickupOrderItems.rawKm,
    productName: schema.products.name,
    externalRef: schema.products.externalRef,
    unitPrice: schema.pickupOrderItems.unitPrice,
  })
  .from(schema.pickupOrderItems)
  .leftJoin(schema.products, eq(schema.products.id, schema.pickupOrderItems.productId))
  .where(
    and(eq(schema.pickupOrderItems.tenantId, tenantId), eq(schema.pickupOrderItems.orderId, id)),
  );
```

Then change `detail()`'s return statement (lines 463-477) to add `exportHeldProductNames`:

```ts
const exportHeldProductNames = [
  ...new Set(
    itemRows.filter((item) => item.externalRef === null).map((item) => item.productName ?? ""),
  ),
];

return {
  ...this.mapRowDto(row),
  employeeBadgeCode: badge?.badgeCode ?? null,
  items: itemRows.map((item) => ({
    id: item.id,
    gtin14: item.gtin14,
    serial: item.serial,
    rawKm: item.rawKm,
    productName: item.productName ?? "",
    unitPrice: item.unitPrice,
  })),
  receiptNo: row.receiptNo,
  actNo: row.actNo,
  syncConflicts: (row.syncConflicts as OrderConflict[] | null) ?? [],
  exportHeldProductNames,
};
```

- [ ] **Step 3: Admin API mirror**

In `apps/admin/src/pages/pickup/api.ts`, add to `PickupOrderRowDto` (after `createdAt: string;`, line 34):

```ts
export interface PickupOrderRowDto {
  id: string;
  orderNo: string;
  employeeName: string;
  kioskName: string;
  reason: PickupOrderReason;
  writeoffReasonName: string | null;
  itemCount: number;
  totalPrice: string | null;
  status: PickupOrderStatus;
  createdAt: string;
  exportedAt: string | null;
  conflictCount: number;
}
```

And to `PickupOrderDetailDto` (line 63-69):

```ts
export interface PickupOrderDetailDto extends PickupOrderRowDto {
  employeeBadgeCode: string | null;
  items: PickupOrderItemDto[];
  receiptNo: string | null;
  actNo: string | null;
  syncConflicts: SyncConflict[];
  exportHeldProductNames: string[];
}
```

- [ ] **Step 4: Admin UI — `OrderDetail.tsx`**

In `apps/admin/src/pages/pickup/OrderDetail.tsx`, add an `Alert` for held orders right after the existing `syncConflicts` alert block (after line 252, before the items `Card`):

```tsx
{
  order.status === "pending" && !order.exportedAt && order.exportHeldProductNames.length > 0 && (
    <Alert
      tone="warn"
      title={t("pages.pickup.detail.exportHeld.title", {
        count: order.exportHeldProductNames.length,
      })}
    >
      <ul style={{ margin: 0, paddingInlineStart: "var(--sp-5)" }}>
        {order.exportHeldProductNames.map((name) => (
          <li key={name} style={{ font: "var(--text-body)" }}>
            {name}
          </li>
        ))}
      </ul>
      <p style={{ font: "var(--text-caption)", color: "var(--fg-3)", marginTop: 8 }}>
        <Link to="/integrations/commerceml">{t("pages.pickup.detail.exportHeld.linkAction")}</Link>
      </p>
    </Alert>
  );
}
```

And add an export-status `DetailField` to the header grid (right after the existing `totalLabel` field, inside the `Card` at lines 217-237):

```tsx
<DetailField
  label={t("pages.pickup.detail.exportStatusLabel")}
  value={
    order.exportedAt
      ? t("pages.pickup.detail.exportStatus.exported", {
          time: formatCreatedAt(order.exportedAt, i18n.language),
        })
      : t("pages.pickup.detail.exportStatus.notExported")
  }
/>
```

- [ ] **Step 5: Admin UI — `ChannelPage.tsx` settings form**

In `apps/admin/src/pages/integrations/ChannelPage.tsx`:

Extend `CommercemlSettingsValues` (lines 33-37):

```ts
interface CommercemlSettingsValues {
  priceType: string;
  splitWriteoffDocument: boolean;
  writeoffDocumentType: string;
  orderStatusField: string;
  statusMapping: { key: string; value: "punched" | "writtenoff" | "cancelled" }[];
  silentAfterHours: number;
}
```

Extend `commercemlSettingsValuesOf` (lines 40-47):

```ts
function commercemlSettingsValuesOf(channel: ChannelDetailDto): CommercemlSettingsValues {
  const rawMapping = channel.settings["statusMapping"];
  const statusMapping =
    rawMapping && typeof rawMapping === "object"
      ? Object.entries(rawMapping as Record<string, string>).map(([key, value]) => ({
          key,
          value: value as "punched" | "writtenoff" | "cancelled",
        }))
      : [];
  return {
    priceType:
      typeof channel.settings["priceType"] === "string" ? channel.settings["priceType"] : "",
    splitWriteoffDocument: Boolean(channel.settings["splitWriteoffDocument"]),
    writeoffDocumentType:
      typeof channel.settings["writeoffDocumentType"] === "string"
        ? channel.settings["writeoffDocumentType"]
        : "",
    orderStatusField:
      typeof channel.settings["orderStatusField"] === "string"
        ? channel.settings["orderStatusField"]
        : "",
    statusMapping,
    silentAfterHours: channel.silentAfterHours,
  };
}
```

Extend `CommercemlSettingsForm`'s body: add three fields and a simple repeatable key/value editor for `statusMapping`, using `useFieldArray` from `react-hook-form` (already a dependency of this form). Replace the `useForm` destructure (lines 84-91) and add the array helper:

```ts
const {
  register,
  handleSubmit,
  reset,
  control,
  formState: { isDirty, errors },
} = useForm<CommercemlSettingsValues>({
  defaultValues: commercemlSettingsValuesOf(channel),
});
const { fields, append, remove } = useFieldArray({ control, name: "statusMapping" });
```

Add the `react-hook-form` import, and add `Select` (with its `SelectOption` type) to the existing `@markiro/ui` import at the top of the file:

```ts
import { Controller, useFieldArray, useForm } from "react-hook-form";
```

```ts
import { Alert, Button, Card, Input, PageHeader, Select, Spinner, StatusChip } from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";
```

(this replaces the file's existing two `@markiro/ui` import lines, lines 6-7).

Add a module-level constant right after `STATE_STATUS` (after line 31), reused for every row's dropdown — `labelKey` (not `label`) because it's an i18n key, translated at render time inside the component (`t(option.labelKey)`), same as every other label in this file:

```ts
const STATUS_MAPPING_OPTIONS: {
  value: "punched" | "writtenoff" | "cancelled";
  labelKey: string;
}[] = [
  { value: "punched", labelKey: "pages.integrations.channel.settings.statusMappingOption.punched" },
  {
    value: "writtenoff",
    labelKey: "pages.integrations.channel.settings.statusMappingOption.writtenoff",
  },
  {
    value: "cancelled",
    labelKey: "pages.integrations.channel.settings.statusMappingOption.cancelled",
  },
];
```

Replace `submit`'s body (lines 99-133) to include the three new fields, converting the `statusMapping` array back into a `Record<string, string>`, and to drop empty-key rows before sending:

```ts
const submit = handleSubmit(async (values) => {
  const priceType = values.priceType.trim();
  const writeoffDocumentType = values.writeoffDocumentType.trim();
  const orderStatusField = values.orderStatusField.trim();
  const statusMapping = Object.fromEntries(
    values.statusMapping
      .filter((row) => row.key.trim().length > 0)
      .map((row) => [row.key.trim(), row.value]),
  );
  try {
    await onSave({
      ...(priceType ? { priceType } : {}),
      splitWriteoffDocument: values.splitWriteoffDocument,
      ...(writeoffDocumentType ? { writeoffDocumentType } : {}),
      ...(orderStatusField ? { orderStatusField } : {}),
      ...(Object.keys(statusMapping).length > 0 ? { statusMapping } : {}),
      silentAfterHours: values.silentAfterHours,
    });
    reset(values);
  } catch {
    // onSave already reported the failure via toast.
  }
});
```

Add the new fields to the JSX, right after the existing `splitWriteoffDocument` checkbox (after line 155, before the `silentAfterHours` `Input`):

```tsx
      <Input
        label={t("pages.integrations.channel.settings.writeoffDocumentTypeLabel")}
        hint={t("pages.integrations.channel.settings.writeoffDocumentTypeHint")}
        {...register("writeoffDocumentType")}
      />
      <Input
        label={t("pages.integrations.channel.settings.orderStatusFieldLabel")}
        hint={t("pages.integrations.channel.settings.orderStatusFieldHint")}
        {...register("orderStatusField")}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ font: "600 13px/18px var(--font-ui)", color: "var(--fg-1)" }}>
          {t("pages.integrations.channel.settings.statusMappingLabel")}
        </span>
        <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
          {t("pages.integrations.channel.settings.statusMappingHint")}
        </span>
        {fields.map((field, index) => (
          <div key={field.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input
              placeholder={t("pages.integrations.channel.settings.statusMappingExternalPlaceholder")}
              {...register(`statusMapping.${index}.key` as const)}
            />
            <Controller
              control={control}
              name={`statusMapping.${index}.value` as const}
              render={({ field: controllerField }) => (
                <Select
                  options={STATUS_MAPPING_OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  }))}
                  value={controllerField.value}
                  onChange={controllerField.onChange}
                />
              )}
            />
            <Button type="button" variant="secondary" onClick={() => remove(index)}>
              {t("pages.integrations.channel.settings.statusMappingRemoveAction")}
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="secondary" onClick={() => append({ key: "", value: "punched" })}>
            {t("pages.integrations.channel.settings.statusMappingAddAction")}
          </Button>
        </div>
      </div>
```

- [ ] **Step 6: i18n keys**

In BOTH `apps/admin/src/i18n/ru.json` and `apps/admin/src/i18n/en.json`, add to `pages.pickup.detail` (alongside the existing keys):

ru.json:

```json
    "exportStatusLabel": "Выгрузка в 1С",
    "exportStatus": {
      "exported": "Выгружена {{time}}",
      "notExported": "Ещё не выгружена"
    },
    "exportHeld": {
      "title": "Заявка придержана — {{count}} товар(ов) без связи с 1С",
      "linkAction": "Перейти к очереди сопоставления"
    },
```

en.json:

```json
    "exportStatusLabel": "1C export",
    "exportStatus": {
      "exported": "Exported {{time}}",
      "notExported": "Not yet exported"
    },
    "exportHeld": {
      "title": "Order held — {{count}} product(s) not linked to 1C",
      "linkAction": "Go to the matching queue"
    },
```

And to `pages.integrations.channel.settings` (alongside the existing keys):

ru.json:

```json
    "writeoffDocumentTypeLabel": "Тип документа для списания",
    "writeoffDocumentTypeHint": "Значение ХозОперация для заявок на списание, когда включено разделение документа.",
    "orderStatusFieldLabel": "Реквизит статуса заказа",
    "orderStatusFieldHint": "Название реквизита, которым 1С сообщает статус заказа — узнаётся у специалиста 1С со стороны клиента.",
    "statusMappingLabel": "Сопоставление статусов",
    "statusMappingHint": "Внешнее значение реквизита → наш статус. Несопоставленное значение не двигает заявку.",
    "statusMappingExternalPlaceholder": "Внешнее значение",
    "statusMappingOption": {
      "punched": "Пробит",
      "writtenoff": "Списан",
      "cancelled": "Отменён"
    },
    "statusMappingAddAction": "Добавить строку",
    "statusMappingRemoveAction": "Удалить",
```

en.json:

```json
    "writeoffDocumentTypeLabel": "Write-off document type",
    "writeoffDocumentTypeHint": "The ХозОперация value for write-off orders, when document splitting is on.",
    "orderStatusFieldLabel": "Order status requisite",
    "orderStatusFieldHint": "The name 1C uses for its order-status requisite — ask the client's own 1C specialist.",
    "statusMappingLabel": "Status mapping",
    "statusMappingHint": "External requisite value → our status. An unmapped value never moves the order.",
    "statusMappingExternalPlaceholder": "External value",
    "statusMappingOption": {
      "punched": "Punched",
      "writtenoff": "Written off",
      "cancelled": "Cancelled"
    },
    "statusMappingAddAction": "Add row",
    "statusMappingRemoveAction": "Remove",
```

- [ ] **Step 7: Run the admin and api test suites**

```bash
pnpm --filter @markiro/api exec vitest run
pnpm --filter @markiro/admin exec vitest run
```

Expected: PASS.

- [ ] **Step 8: Typecheck both packages**

```bash
pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit
pnpm --filter @markiro/admin exec tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 9: Manually verify in the browser**

Start the admin dev server, open a pending pickup order that has an unlinked product, confirm the held-order alert renders and links to the CommerceML channel page; open the CommerceML channel's settings and confirm the new fields save and reload correctly (add a status-mapping row, save, reload the page, confirm it's still there).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/pickup-orders/dto.ts apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/admin/src/pages/pickup/api.ts apps/admin/src/pages/pickup/OrderDetail.tsx apps/admin/src/pages/integrations/ChannelPage.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json
git commit -m "feat(admin): show 1С export/held state on orders, add status-mapping settings UI"
```

---

## Task 16: Acceptance checklist + final review + full gate

**Files:**

- Modify: `docs/1c-exchange-acceptance-checklist.md`

- [ ] **Step 1: Rewrite the И-2 section of the acceptance checklist**

Replace the existing `## Input for plan И-2 (order status)` section in `docs/1c-exchange-acceptance-checklist.md` with:

```markdown
## Order export & status reconciliation (plan И-2)

- [ ] Configure the requisite name this client's 1С configuration uses for
      order status (`СтатусЗаказа`-shaped or otherwise) as `orderStatusField`
      on the CommerceML channel's settings, and its full dictionary of values
      as `statusMapping` — this cannot be guessed from any synthetic fixture;
      it must come from the client's own 1С specialist or a live document
      dump.
- [ ] Run a full `checkauth → init → query → success` cycle against a real
      1С instance with a genuine pending pickup order queued; confirm 1С's
      importer accepts the outbound `<Документ>` shape this exchange builds
      (`order-export.ts`) — a synthetic assertion can only prove the XML is
      well-formed and internally consistent, never that a real 1С
      configuration's importer parses these exact tag names/shape the way
      this exchange assumes.
- [ ] Confirm a real 1С configuration's own outgoing "changed order" export
      (`type=sale&mode=file`) actually carries the order status inside
      `<ЗначенияРеквизитов>`/`<ЗначениеРеквизита>`, in the shape
      `order-status.ts` expects, rather than some other document structure
      this exchange has not been built against.
- [ ] Confirm `splitWriteoffDocument` + `writeoffDocumentType` actually route
      to a distinct document type this client's own 1С configuration
      recognizes, if the client wants writeoffs split — this is a
      per-configuration dictionary (спека §2), so there is no default this
      exchange can assume is right.

## Already covered — do not re-spend the live session on these

- ~~That an order held back because of an unlinked product does not silently
  vanish~~ — covered by `commerceml-order-export.test.ts`'s `planExport`
  tests and `pickup-orders.e2e.test.ts`'s `findExportCandidates` test: the
  order simply doesn't appear in `plan.eligible` until every item's product
  carries an `external_ref`.
- ~~That `mode=success` only confirms what THIS session's own `mode=query`
  actually offered~~ — covered by `exchange-protocol.e2e.test.ts`'s outbound
  cycle test, which asserts the SAME order is not re-offered on a second
  `mode=query` round after `mode=success`.
- ~~That an unmapped external status never silently moves an order~~ —
  covered by `exchange-protocol.e2e.test.ts`'s inbound reconciliation test
  (unmapped-value case) and `commerceml-order-status.test.ts`'s
  `resolveMappedStatus` tests.
```

- [ ] **Step 2: Run the full local gate**

```bash
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
```

Expected: all green. Fix anything that fails before proceeding.

- [ ] **Step 3: Self-review against this plan and the spec**

Re-read `docs/superpowers/specs/2026-07-29-commerceml-design.md` §5-§9 section by section and confirm every requirement has a corresponding task above:

- §5 outbound export (Tasks 4, 6, 8, 9, 10, 13) — done.
- §5 held orders (Tasks 4, 6, 15) — done.
- §6 status mapping, both directions (Tasks 2, 5, 7, 12, 14, 15) — done.
- §6 unmapped-status handling (Tasks 5, 12, 14) — done.
- §7 observability additions (journal events on held/query/success/discrepancy — Tasks 10, 11, 12) — done.
- §9's И-2 scope boundary ("Исходящий поток, придержанные заявки, сопоставление статусов") — matches exactly; no scope creep beyond it.

- [ ] **Step 4: Commit**

```bash
git add docs/1c-exchange-acceptance-checklist.md
git commit -m "docs: rewrite И-2 acceptance checklist section, confirm full gate green"
```
