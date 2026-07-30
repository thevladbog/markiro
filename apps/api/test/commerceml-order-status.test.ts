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
