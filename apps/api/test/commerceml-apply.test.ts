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
    expect(plan.skipped).toEqual([{ externalRef: "guid-1", reason: "ambiguous_price_type" }]);
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
});
