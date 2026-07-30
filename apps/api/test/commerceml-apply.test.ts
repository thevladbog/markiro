import { describe, expect, it } from "vitest";
import { decideApplication } from "../src/modules/exchange/commerceml/apply";

const known = [{ id: "p-1", externalRef: "guid-1" }];

describe("decideApplication", () => {
  it("применяет цену сопоставленному товару", () => {
    const plan = decideApplication({
      known,
      items: [{ externalRef: "guid-1", name: "Жигулёвское", article: null, unit: "шт" }],
      offers: [
        { externalRef: "guid-1", prices: [{ type: "Розничная", value: "89.90", currency: "руб" }] },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([{ productId: "p-1", unitPrice: "89.90" }]);
    expect(plan.candidates).toEqual([]);
  });

  it("несопоставленное уходит в кандидаты, а не создаёт товар", () => {
    const plan = decideApplication({
      known,
      items: [{ externalRef: "guid-9", name: "Новинка", article: "N-1", unit: "шт" }],
      offers: [],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.candidates.map((c) => c.externalRef)).toEqual(["guid-9"]);
  });

  it("при нескольких типах цен и ненастроенном выборе НЕ применяет ничего", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        {
          externalRef: "guid-1",
          prices: [
            { type: "Розничная", value: "89.90", currency: "руб" },
            { type: "Закупочная", value: "54.10", currency: "руб" },
          ],
        },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        externalRef: "guid-1",
        reason: "ambiguous_price_type",
        priceTypes: ["Розничная", "Закупочная"],
      },
    ]);
  });

  it("настроенный тип цены выбирает свою из нескольких", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        {
          externalRef: "guid-1",
          prices: [
            { type: "Розничная", value: "89.90", currency: "руб" },
            { type: "Закупочная", value: "54.10", currency: "руб" },
          ],
        },
      ],
      configuredPriceType: "Закупочная",
    });
    expect(plan.priceUpdates).toEqual([{ productId: "p-1", unitPrice: "54.10" }]);
  });

  it("настроенный тип цены побеждает единственную пришедшую цену другого типа", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        {
          externalRef: "guid-1",
          prices: [{ type: "Закупочная", value: "54.10", currency: "руб" }],
        },
      ],
      configuredPriceType: "Розничная",
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        externalRef: "guid-1",
        reason: "configured_price_type_not_found",
        priceTypes: ["Закупочная"],
      },
    ]);
  });

  it("несколько записей одного типа не считаются неоднозначностью", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        {
          externalRef: "guid-1",
          prices: [
            { type: "Розничная", value: "89.90", currency: "руб" },
            { type: "Розничная", value: "89.90", currency: "руб" },
          ],
        },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([{ productId: "p-1", unitPrice: "89.90" }]);
    expect(plan.skipped).toEqual([]);
  });

  it("не применяет цену в чужой валюте", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        { externalRef: "guid-1", prices: [{ type: "Розничная", value: "1.20", currency: "USD" }] },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.skipped).toEqual([{ externalRef: "guid-1", reason: "foreign_currency" }]);
  });

  it("отсутствие цены не обнуляет прежнюю", () => {
    const plan = decideApplication({
      known,
      items: [{ externalRef: "guid-1", name: "Жигулёвское", article: null, unit: "шт" }],
      offers: [],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
  });

  // Fix 3 (final review): `unitPrice` used to go straight from `parse.ts`'s
  // raw string into `numeric(12,2)` with no check at all. A single bad price
  // in an otherwise-fine offer file used to bring the whole `mode=import`
  // round down with `invalid input syntax for type numeric` -- Postgres
  // rejects the write, the exception filter journals the raw text, the
  // cursor never advances, and 1С resubmits the SAME file forever. Rejecting
  // the value here, the same way a foreign currency is rejected, keeps the
  // import moving: one bad offer is skipped with a reason, not a dead loop.
  it("пустое значение цены не применяется и пропускается с причиной", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        { externalRef: "guid-1", prices: [{ type: "Розничная", value: "", currency: "руб" }] },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.skipped).toEqual([{ externalRef: "guid-1", reason: "invalid_price_value" }]);
  });

  it("цена с запятой вместо точки не применяется и пропускается с причиной", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        { externalRef: "guid-1", prices: [{ type: "Розничная", value: "89,90", currency: "руб" }] },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.skipped).toEqual([{ externalRef: "guid-1", reason: "invalid_price_value" }]);
  });

  it("цена, переполняющая numeric(12,2), не применяется и пропускается с причиной", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        {
          externalRef: "guid-1",
          prices: [{ type: "Розничная", value: "123456789012.00", currency: "руб" }],
        },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.skipped).toEqual([{ externalRef: "guid-1", reason: "invalid_price_value" }]);
  });

  // Fix 4 (final review): a real "пакет предложений" commonly arrives split
  // across files -- the `<ТипыЦен>` catalog lives in whichever file declares
  // it, but each file is parsed independently (`exchange.controller.ts`
  // parses one assembled file per `mode=import` call), so an offers-only file
  // can carry several distinct `<ИдТипЦены>` GUIDs that ALL fail to resolve
  // to a name in that file's own parse. Before this fix, `distinctPriceTypes`
  // keyed only by `type`, so every one of those unresolved refs read as the
  // same "" bucket -- "one type" -- and `choosePrice` silently took the
  // first price, which is exactly spec §4.3's forbidden case reached through
  // an unresolved reference instead of an outright ambiguous name.
  it("несколько разных НЕРАЗРЕШЁННЫХ ссылок на тип цены не сливаются в одну — цена не применяется", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        {
          externalRef: "guid-1",
          prices: [
            { type: "", typeRef: "type-guid-a", value: "89.90", currency: "руб" },
            { type: "", typeRef: "type-guid-b", value: "54.10", currency: "руб" },
          ],
        },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        externalRef: "guid-1",
        reason: "ambiguous_price_type",
        priceTypes: ["type-guid-a", "type-guid-b"],
      },
    ]);
  });

  it("одна непригодная цена не останавливает остальные предложения того же круга", () => {
    const plan = decideApplication({
      known: [...known, { id: "p-2", externalRef: "guid-2" }],
      items: [],
      offers: [
        { externalRef: "guid-1", prices: [{ type: "Розничная", value: "89,90", currency: "руб" }] },
        { externalRef: "guid-2", prices: [{ type: "Розничная", value: "10.00", currency: "руб" }] },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([{ productId: "p-2", unitPrice: "10.00" }]);
    expect(plan.skipped).toEqual([{ externalRef: "guid-1", reason: "invalid_price_value" }]);
  });
});
