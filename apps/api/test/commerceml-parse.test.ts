import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCatalog, parseOffers } from "../src/modules/exchange/commerceml/parse";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/commerceml", name));

describe("commerceml parse", () => {
  it("читает windows-1251 — 1С выгружает в ней по умолчанию, и utf-8 превратил бы кириллицу в мусор", () => {
    const catalog = parseCatalog(fixture("import-cp1251.xml"));
    expect(catalog.items[0]!.name).toBe("Жигулёвское 0,5");
  });

  it("берёт Ид как внешний идентификатор, а не наименование", () => {
    const catalog = parseCatalog(fixture("import-cp1251.xml"));
    expect(catalog.items[0]!.externalRef).toBe("a1b2c3d4-0000-0000-0000-000000000001");
  });

  it("отдаёт все типы цен, а не первый попавшийся — выбор делает вызывающий", () => {
    const offers = parseOffers(fixture("offers.xml"));
    expect(offers.offers[0]!.prices).toEqual([
      { type: "Розничная", value: "89.90", currency: "руб" },
      { type: "Закупочная", value: "54.10", currency: "руб" },
    ]);
  });

  it("не падает на файле без товаров", () => {
    const empty = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><КоммерческаяИнформация/>',
      "utf8",
    );
    expect(parseCatalog(empty).items).toEqual([]);
    expect(parseOffers(empty).offers).toEqual([]);
  });

  it("сообщает о неразобранном XML, а не возвращает пустоту", () => {
    expect(() => parseCatalog(Buffer.from("<не xml", "utf8"))).toThrow(/CommerceML/);
  });
});
