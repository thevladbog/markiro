import { expect, it } from "vitest";
import { makeUnitLabelFacts, unitLabelFactsSchema, warehouseBoxSource } from "../src/index.js";
it("checks the digest and excludes raw product codes from uploaded facts", () => {
  const input = {
    version: 1 as const,
    shiftId: "00000000-0000-4000-8000-000000000010",
    codeHash: "a".repeat(64),
    acceptedAt: "2026-10-08T12:00:00.000Z",
    fields: { ...warehouseBoxSource().fields, sscc: "", qty: "1", "km.code": "" },
    dateProvenance: "saved_print_job" as const,
  };
  const facts = makeUnitLabelFacts(input);
  expect(
    unitLabelFactsSchema.safeParse({ ...facts, fields: { ...facts.fields, expiry: "changed" } })
      .success,
  ).toBe(false);
  expect(() =>
    makeUnitLabelFacts({
      ...input,
      fields: { ...input.fields, "km.code": "010460000000001521SECRET" },
    }),
  ).toThrow();
});
