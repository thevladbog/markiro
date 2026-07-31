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
  writeoffDocumentType?: string | null | undefined;
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
