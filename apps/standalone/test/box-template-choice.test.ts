import { describe, expect, it } from "vitest";

import {
  suggestBoxTemplate,
  suggestPalletTemplate,
  type BoxTemplateCandidate,
  type BoxTemplateDefaults,
} from "../src/lib/box-template-choice.js";

const PREFERRED = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

/** An enabled box template for every category. */
function box(id: string, scope: Partial<BoxTemplateCandidate> = {}): BoxTemplateCandidate {
  return { id, purpose: "box", enabled: true, chzProductGroupCodes: null, ...scope };
}

const TEMPLATES = [box(PREFERRED), box(CATEGORY, { chzProductGroupCodes: [8] }), box(ORGANIZATION)];

const DEFAULTS: BoxTemplateDefaults = {
  defaultBoxTemplateId: ORGANIZATION,
  categories: [
    { chzProductGroupCode: 8, purpose: "pallet", templateId: OTHER },
    { chzProductGroupCode: 13, purpose: "box", templateId: OTHER },
    { chzProductGroupCode: 8, purpose: "box", templateId: CATEGORY },
  ],
};

const MILK = { chzProductGroupCode: 8, defaultBoxTemplateId: PREFERRED };

describe("the box template a new shift starts with", () => {
  it("takes the product's preference when it fits", () => {
    expect(suggestBoxTemplate(MILK, TEMPLATES, DEFAULTS)).toBe(PREFERRED);
  });

  it("passes over a preference that is off, of another purpose, narrowed away or gone, to the category's box default", () => {
    for (const preferred of [
      box(PREFERRED, { enabled: false }),
      box(PREFERRED, { purpose: "pallet" }),
      box(PREFERRED, { chzProductGroupCodes: [13] }),
    ]) {
      const templates = [preferred, ...TEMPLATES.slice(1)];
      expect(suggestBoxTemplate(MILK, templates, DEFAULTS), JSON.stringify(preferred)).toBe(
        CATEGORY,
      );
    }
    expect(suggestBoxTemplate(MILK, TEMPLATES.slice(1), DEFAULTS)).toBe(CATEGORY);
    expect(suggestBoxTemplate({ ...MILK, defaultBoxTemplateId: null }, TEMPLATES, DEFAULTS)).toBe(
      CATEGORY,
    );
  });

  it("takes the organization's default when the category has no box default, or its default does not fit or is gone", () => {
    const noPreference = { chzProductGroupCode: 8, defaultBoxTemplateId: null };
    const withoutCategory = { ...DEFAULTS, categories: DEFAULTS.categories.slice(0, 2) };
    expect(suggestBoxTemplate(noPreference, TEMPLATES, withoutCategory)).toBe(ORGANIZATION);
    const categoryOff = [
      box(PREFERRED),
      box(CATEGORY, { enabled: false, chzProductGroupCodes: [8] }),
      box(ORGANIZATION),
    ];
    expect(suggestBoxTemplate(noPreference, categoryOff, DEFAULTS)).toBe(ORGANIZATION);
    // Group 13's box default is not in the list.
    const water = { chzProductGroupCode: 13, defaultBoxTemplateId: null };
    expect(suggestBoxTemplate(water, TEMPLATES, DEFAULTS)).toBe(ORGANIZATION);
  });

  it("reads only the box default of the product's own group", () => {
    const noPreference = { chzProductGroupCode: 8, defaultBoxTemplateId: null };
    // `OTHER` fits as a box template, but it is group 8's pallet default and group 13's box default.
    const templates = [...TEMPLATES, box(OTHER)];
    const others = { ...DEFAULTS, categories: DEFAULTS.categories.slice(0, 2) };
    expect(suggestBoxTemplate(noPreference, templates, others)).toBe(ORGANIZATION);
  });

  it("skips the category for a product without a group, and gives none when nothing fits", () => {
    const noGroup = { chzProductGroupCode: null, defaultBoxTemplateId: null };
    expect(suggestBoxTemplate(noGroup, TEMPLATES, DEFAULTS)).toBe(ORGANIZATION);
    const narrowed = [box(ORGANIZATION, { chzProductGroupCodes: [13] })];
    expect(suggestBoxTemplate(noGroup, narrowed, DEFAULTS)).toBeNull();
    expect(suggestBoxTemplate(noGroup, [], DEFAULTS)).toBeNull();
  });

  it("counts only the preference while the defaults are not read", () => {
    expect(suggestBoxTemplate(MILK, TEMPLATES, null)).toBe(PREFERRED);
    expect(suggestBoxTemplate({ ...MILK, defaultBoxTemplateId: null }, TEMPLATES, null)).toBeNull();
  });
});

describe("the pallet template a new shift with pallets starts with (plan ПЛ-Ц)", () => {
  const pallet = (id: string, scope: Partial<BoxTemplateCandidate> = {}): BoxTemplateCandidate =>
    box(id, { purpose: "pallet", ...scope });
  const PALLETS = [
    pallet(PREFERRED),
    pallet(CATEGORY, { chzProductGroupCodes: [8] }),
    pallet(ORGANIZATION),
    box(OTHER),
  ];
  const PALLET_DEFAULTS = {
    defaultPalletTemplateId: ORGANIZATION,
    categories: [
      { chzProductGroupCode: 8, purpose: "box", templateId: OTHER },
      { chzProductGroupCode: 8, purpose: "pallet", templateId: CATEGORY },
    ],
  };

  it("takes the product's pallet preference, then its category's pallet default, then the organization's", () => {
    const milk = { chzProductGroupCode: 8, defaultPalletTemplateId: PREFERRED };
    expect(suggestPalletTemplate(milk, PALLETS, PALLET_DEFAULTS)).toBe(PREFERRED);
    expect(
      suggestPalletTemplate({ ...milk, defaultPalletTemplateId: null }, PALLETS, PALLET_DEFAULTS),
    ).toBe(CATEGORY);
    expect(
      suggestPalletTemplate(
        { chzProductGroupCode: 13, defaultPalletTemplateId: null },
        PALLETS,
        PALLET_DEFAULTS,
      ),
    ).toBe(ORGANIZATION);
  });

  it("passes over a pallet preference that is off, of another purpose, narrowed away or gone", () => {
    const milk = { chzProductGroupCode: 8, defaultPalletTemplateId: PREFERRED };
    for (const preferred of [
      pallet(PREFERRED, { enabled: false }),
      box(PREFERRED),
      pallet(PREFERRED, { chzProductGroupCodes: [13] }),
    ]) {
      const templates = [preferred, ...PALLETS.slice(1)];
      expect(
        suggestPalletTemplate(milk, templates, PALLET_DEFAULTS),
        JSON.stringify(preferred),
      ).toBe(CATEGORY);
    }
    expect(suggestPalletTemplate(milk, PALLETS.slice(1), PALLET_DEFAULTS)).toBe(CATEGORY);
    // The category default off or gone: the organization's.
    expect(
      suggestPalletTemplate(
        { ...milk, defaultPalletTemplateId: null },
        [pallet(CATEGORY, { enabled: false, chzProductGroupCodes: [8] }), pallet(ORGANIZATION)],
        PALLET_DEFAULTS,
      ),
    ).toBe(ORGANIZATION);
    // A product without a group has no category default.
    expect(
      suggestPalletTemplate(
        { chzProductGroupCode: null, defaultPalletTemplateId: null },
        PALLETS,
        PALLET_DEFAULTS,
      ),
    ).toBe(ORGANIZATION);
  });

  it("never takes a box template, and leaves the choice when none fits", () => {
    const milk = { chzProductGroupCode: 8, defaultPalletTemplateId: OTHER };
    expect(
      suggestPalletTemplate(milk, [box(OTHER)], { defaultPalletTemplateId: OTHER, categories: [] }),
    ).toBeNull();
  });
});
