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
    const weirdOrder: ExportCandidateOrder = { ...baseOrder, orderNo: 'A&B <test>' };
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
