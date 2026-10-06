import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { ProductGroup } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import {
  defaultConflict,
  describeDefaultConflict,
  describeScope,
  dpiText,
  groupName,
  PURPOSE_TONE,
  PURPOSES,
  sizeText,
  templateFailure,
} from "../src/office/templates/template-text.js";

const t = i18n.t;

const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 13, alias: "water", name: "Упакованная вода" },
];

function conflict(details: Record<string, unknown>): HostError {
  return new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: "conflict",
    details,
  });
}

describe("template texts", () => {
  it("write a size in millimetres, a fraction with a comma, and none when the layout lacks the width or the height", () => {
    expect(sizeText({ widthMm: 58, heightMm: 40 }, t)).toBe("58 × 40 мм");
    expect(sizeText({ widthMm: 58.5, heightMm: 100 }, t)).toBe("58,5 × 100 мм");
    expect(sizeText({ widthMm: null, heightMm: 40 }, t)).toBe("—");
    expect(sizeText({ widthMm: 58, heightMm: null }, t)).toBe("—");
  });

  it("round a millimetre to two decimals, and write a zero side as a size, not as a missing one", () => {
    expect(sizeText({ widthMm: 58.254, heightMm: 40.1 }, t)).toBe("58,25 × 40,1 мм");
    expect(sizeText({ widthMm: 0, heightMm: 40 }, t)).toBe("0 × 40 мм");
  });

  it("write a resolution in dpi, and none without one", () => {
    expect(dpiText(203, t)).toBe("203 dpi");
    expect(dpiText(0, t)).toBe("0 dpi");
    expect(dpiText(null, t)).toBe("—");
  });

  it("name a product group from the lookup, and by its code when the lookup lacks it or did not load", () => {
    expect(groupName(GROUPS, 13, t)).toBe("Упакованная вода");
    expect(groupName(GROUPS, 99, t)).toBe("Код 99");
    expect(groupName(undefined, 8, t)).toBe("Код 8");
  });

  it("describe the categories: every one, one by name, or how many with the names as a title", () => {
    expect(describeScope(null, GROUPS, t)).toStrictEqual({ label: "Все категории", title: null });
    expect(describeScope([13], GROUPS, t)).toStrictEqual({
      label: "Упакованная вода",
      title: "Упакованная вода",
    });
    expect(describeScope([8, 13, 99], GROUPS, t)).toStrictEqual({
      label: "Категорий: 3",
      title: "Молочная продукция, Упакованная вода, Код 99",
    });
    expect(describeScope([8, 13], undefined, t)).toStrictEqual({
      label: "Категорий: 2",
      title: "Код 8, Код 13",
    });
  });

  it("offer the purposes box, pallet, duplicate and tone them as the cloud does: violet, magenta, teal", () => {
    expect(PURPOSES).toStrictEqual(["box", "pallet", "product_duplicate"]);
    expect(PURPOSE_TONE).toStrictEqual({
      box: "violet",
      product_duplicate: "teal",
      pallet: "magenta",
    });
  });
});

describe("a refused template write", () => {
  it("names the defaults in its way only for a `template_is_default` conflict", () => {
    expect(
      defaultConflict(
        conflict({
          constraint: "template_is_default",
          organizationDefault: true,
          categoryDefaults: [8, 15],
        }),
      ),
    ).toStrictEqual({ organization: true, categories: [8, 15] });
    expect(
      defaultConflict(
        conflict({
          constraint: "template_is_default",
          organizationDefault: false,
          categoryDefaults: [],
        }),
      ),
    ).toStrictEqual({ organization: false, categories: [] });
    // Only a real `true` is the organization's default, and unreadable codes name no category.
    expect(
      defaultConflict(
        conflict({
          constraint: "template_is_default",
          organizationDefault: "true",
          categoryDefaults: ["8"],
        }),
      ),
    ).toStrictEqual({ organization: false, categories: [] });
    expect(defaultConflict(conflict({ constraint: "stock_template" }))).toBeNull();
    const stale = new HostError({
      kind: "api",
      code: "stale_revision",
      status: 409,
      message: "stale",
      details: { constraint: "template_is_default" },
    });
    expect(defaultConflict(stale)).toBeNull();
    expect(defaultConflict(new Error("template_is_default"))).toBeNull();
  });

  it("takes only a HostError for a default conflict: not an error-shaped object, and not a rejection with no error in it", () => {
    const shaped = { code: "conflict", details: { constraint: "template_is_default" } };
    expect(defaultConflict(shaped)).toBeNull();
    expect(defaultConflict(undefined)).toBeNull();
    expect(defaultConflict(null)).toBeNull();
    expect(defaultConflict("template_is_default")).toBeNull();
  });

  it("reads the category codes the way the host writes them: whole numbers from zero up, else no category is named", () => {
    const named = (categoryDefaults: unknown) =>
      defaultConflict(conflict({ constraint: "template_is_default", categoryDefaults }));
    expect(named([0, 8])).toStrictEqual({ organization: false, categories: [0, 8] });
    expect(named([8, -1])).toStrictEqual({ organization: false, categories: [] });
    expect(named([8, 1.5])).toStrictEqual({ organization: false, categories: [] });
    expect(named("8")).toStrictEqual({ organization: false, categories: [] });
    expect(named(undefined)).toStrictEqual({ organization: false, categories: [] });
  });

  it("explains whose default the template is, the categories by name or code, and where to choose another", () => {
    const hint = "Сначала выберите другой шаблон на странице «Умолчания шаблонов».";
    expect(describeDefaultConflict({ organization: true, categories: [] }, GROUPS, t)).toBe(
      `Шаблон выбран по умолчанию для организации. ${hint}`,
    );
    expect(describeDefaultConflict({ organization: false, categories: [8, 99] }, GROUPS, t)).toBe(
      `Шаблон выбран по умолчанию для категорий: Молочная продукция, Код 99. ${hint}`,
    );
    expect(describeDefaultConflict({ organization: true, categories: [13] }, undefined, t)).toBe(
      `Шаблон выбран по умолчанию для организации. Шаблон выбран по умолчанию для категорий: Код 13. ${hint}`,
    );
  });

  it("is a default conflict, a stale write that offers to reload, or an alert by its code", () => {
    expect(
      templateFailure(
        conflict({
          constraint: "template_is_default",
          organizationDefault: true,
          categoryDefaults: [8],
        }),
      ),
    ).toStrictEqual({ kind: "default", conflict: { organization: true, categories: [8] } });
    expect(
      templateFailure(
        new HostError({ kind: "api", code: "stale_revision", status: 409, message: "stale" }),
      ),
    ).toStrictEqual({ kind: "stale" });
    expect(templateFailure(conflict({ constraint: "stock_template" }))).toStrictEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
  });

  it("says a template deleted on another workstation is gone", () => {
    expect(
      templateFailure(
        new HostError({ kind: "api", code: "not_found", status: 404, message: "gone" }),
      ),
    ).toStrictEqual({ kind: "alert", message: "office.templateEditor.errors.missing" });
  });
});
