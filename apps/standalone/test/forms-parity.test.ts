import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  boxReportRowsSchema,
  counterpartyRecordSchema,
  officeLineSchema,
  officeProductSchema,
  officeShiftSchema,
  orgProfileSchema,
  palletReportRowsSchema,
} from "../src/host/protocol.js";
import { renderForm, type FormRequest } from "../src/office/forms/render-form.js";

/**
 * The standalone's half of the printed forms' parity with the cloud (plan
 * О-Ф). Each case of `packages/domain/test/fixtures/print-forms-parity/cases.json`
 * holds the host's rows (or the office's records) for some facts; the
 * office's own `renderForm` must draw exactly the HTML of `golden.json`,
 * which the cloud's controllers wrote from the cloud loaders' input for the
 * same facts (`apps/api/test/standalone-forms-parity.test.ts`).
 */

const testModuleUrl = import.meta.url;

function read(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/domain/test/fixtures/print-forms-parity/${name}`, testModuleUrl),
      "utf8",
    ),
  );
}

// The cases are the cloud's, written before a shift named an A4 sheet (plan А4):
// a shift of theirs has none, and the printed forms never read the sheet.
const parityShiftSchema = officeShiftSchema.extend({
  palletSheetTemplateId: officeShiftSchema.shape.palletSheetTemplateId.default(null),
});

const format = z.enum(["a4", "a5"]);
const caseSchema = z.discriminatedUnion("form", [
  z.object({
    name: z.string(),
    form: z.literal("box"),
    timeZone: z.string(),
    host: z.object({ rows: boxReportRowsSchema }),
  }),
  z.object({
    name: z.string(),
    form: z.literal("pallet"),
    timeZone: z.string(),
    palletId: z.string(),
    host: z.object({ rows: palletReportRowsSchema }),
  }),
  z.object({
    name: z.string(),
    form: z.literal("placard"),
    format,
    palletId: z.string(),
    host: z.object({ rows: palletReportRowsSchema }),
  }),
  z.object({
    name: z.string(),
    form: z.literal("placards"),
    format,
    host: z.object({ rows: palletReportRowsSchema }),
  }),
  z.object({
    name: z.string(),
    form: z.literal("task"),
    generatedAt: z.iso.datetime(),
    host: z.object({
      shift: parityShiftSchema,
      product: officeProductSchema,
      line: officeLineSchema,
      counterparty: counterpartyRecordSchema.nullable(),
      organization: orgProfileSchema,
    }),
  }),
]);
type ParityCase = z.infer<typeof caseSchema>;

// The cases' `cloud` inputs are the cloud test's; the schemas here drop them.
const cases = z.object({ cases: z.array(caseSchema) }).parse(read("cases.json")).cases;
const golden = z
  .record(z.string(), z.object({ bytes: z.number(), sha256: z.string(), html: z.string() }))
  .parse(read("golden.json"));

/** The office's request for the case's form. */
function requestOf(parityCase: ParityCase): FormRequest {
  switch (parityCase.form) {
    case "box":
      return { kind: "box", rows: parityCase.host.rows, timeZone: parityCase.timeZone };
    case "pallet":
      return {
        kind: "pallet",
        rows: parityCase.host.rows,
        palletId: parityCase.palletId,
        timeZone: parityCase.timeZone,
      };
    case "placard":
      return {
        kind: "placard",
        rows: parityCase.host.rows,
        palletId: parityCase.palletId,
        format: parityCase.format,
      };
    case "placards":
      return { kind: "placards", rows: parityCase.host.rows, format: parityCase.format };
    case "task":
      return {
        kind: "task",
        inputs: parityCase.host,
        generatedAt: new Date(parityCase.generatedAt),
      };
  }
}

describe("printed forms parity with the cloud (plan О-Ф)", () => {
  it("covers every case the cloud's golden has", () => {
    expect(cases.map((parityCase) => parityCase.name)).toEqual(Object.keys(golden));
  });

  it.each(cases.map((parityCase) => [parityCase.name, parityCase] as const))(
    "%s: the office draws the cloud's bytes from the host's rows",
    (name, parityCase) => {
      const drawn = renderForm(requestOf(parityCase));
      const expected = golden[name];
      expect(drawn?.kind).toBe(parityCase.form);
      expect(drawn?.html).toBe(expected?.html);
      expect(
        createHash("sha256")
          .update(drawn?.html ?? "", "utf8")
          .digest("hex"),
      ).toBe(expected?.sha256);
    },
  );
});
