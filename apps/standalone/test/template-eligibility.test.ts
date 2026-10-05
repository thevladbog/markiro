import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { templateFitsSlot, type TemplateScope } from "../src/lib/template-eligibility.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

const purposeSchema = z.enum(["box", "pallet", "product_duplicate"]);

/**
 * `proto/fixtures/template-eligibility.json`, read strictly: a key the host's
 * side adds to a case fails here, so the two sides never test different things.
 */
const ELIGIBILITY = z
  .strictObject({
    cases: z.array(
      z.strictObject({
        template: z.strictObject({
          purpose: purposeSchema,
          enabled: z.boolean(),
          chzProductGroupCodes: z.array(z.number().int()).nullable(),
        }),
        slot: z.strictObject({
          purpose: purposeSchema,
          chzProductGroupCode: z.number().int().nullable(),
        }),
        fits: z.boolean(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/template-eligibility.json", testModuleUrl), "utf8"),
    ),
  );

describe("template eligibility: the fixture the host's templates::fits answers too", () => {
  it("holds twelve cases, with a slot of every purpose", () => {
    expect(ELIGIBILITY.cases).toHaveLength(12);
    expect(new Set(ELIGIBILITY.cases.map((each) => each.slot.purpose))).toEqual(
      new Set(["box", "pallet", "product_duplicate"]),
    );
  });

  it.each(ELIGIBILITY.cases.map((each, index) => [index, each] as const))(
    "answers case %i as the host does",
    (_index, each) => {
      expect(templateFitsSlot(each.template, each.slot)).toBe(each.fits);
    },
  );
});

describe("template eligibility of a product duplicate, which the domain has no rule for", () => {
  const SCOPED: TemplateScope = {
    purpose: "product_duplicate",
    enabled: true,
    chzProductGroupCodes: [15],
  };

  it("takes an enabled duplicate template that covers the category, and no other", () => {
    expect(
      templateFitsSlot(SCOPED, { purpose: "product_duplicate", chzProductGroupCode: 15 }),
    ).toBe(true);
    expect(templateFitsSlot(SCOPED, { purpose: "product_duplicate", chzProductGroupCode: 8 })).toBe(
      false,
    );
    expect(
      templateFitsSlot(
        { ...SCOPED, chzProductGroupCodes: null },
        { purpose: "product_duplicate", chzProductGroupCode: 8 },
      ),
    ).toBe(true);
    expect(
      templateFitsSlot(
        { ...SCOPED, chzProductGroupCodes: [8, 15] },
        { purpose: "product_duplicate", chzProductGroupCode: 15 },
      ),
    ).toBe(true);
  });

  it("needs a template for every category in the organization's slot", () => {
    expect(
      templateFitsSlot(SCOPED, { purpose: "product_duplicate", chzProductGroupCode: null }),
    ).toBe(false);
    expect(
      templateFitsSlot(
        { ...SCOPED, chzProductGroupCodes: null },
        { purpose: "product_duplicate", chzProductGroupCode: null },
      ),
    ).toBe(true);
  });

  it("takes no template of another purpose, and puts a duplicate template in no other slot", () => {
    expect(
      templateFitsSlot(
        { ...SCOPED, purpose: "box" },
        { purpose: "product_duplicate", chzProductGroupCode: 15 },
      ),
    ).toBe(false);
    expect(templateFitsSlot(SCOPED, { purpose: "box", chzProductGroupCode: 15 })).toBe(false);
    expect(templateFitsSlot(SCOPED, { purpose: "pallet", chzProductGroupCode: 15 })).toBe(false);
  });
});
