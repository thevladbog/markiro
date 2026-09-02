import { describe, expect, it } from "vitest";

import i18n from "../src/i18n/index.js";
import { describeDefaultConflict, describeTemplateScope } from "../src/pages/labels/scope.js";

const GROUPS = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 15, alias: "beer", name: "Пиво" },
  { code: 22, alias: "nabeer", name: "Безалкогольное пиво" },
];

describe("describeTemplateScope", () => {
  it("names universal scope, lists up to two categories, counts three or more", () => {
    const t = i18n.getFixedT("ru");
    expect(describeTemplateScope(null, GROUPS, t)).toEqual({ label: "Все категории", title: null });
    expect(describeTemplateScope([15, 8], GROUPS, t)).toEqual({
      label: "Пиво, Молочная продукция",
      title: null,
    });
    expect(describeTemplateScope([15, 8, 22], GROUPS, t)).toEqual({
      label: "Категорий: 3",
      title: "Пиво, Молочная продукция, Безалкогольное пиво",
    });
    expect(describeTemplateScope([999], GROUPS, t).label).toBe("999");
  });
});

describe("describeDefaultConflict", () => {
  it("explains which defaults block the change", () => {
    const t = i18n.getFixedT("ru");
    expect(
      describeDefaultConflict({ organizationDefault: true, categoryDefaults: [15] }, GROUPS, t),
    ).toBe(
      "Шаблон назначен дефолтом организации. Шаблон назначен дефолтом категорий: Пиво. Сначала выберите другой шаблон в настройках организации.",
    );
    expect(describeDefaultConflict(null, GROUPS, t)).toBe(
      "Сначала выберите другой шаблон в настройках организации.",
    );
  });
});
