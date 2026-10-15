import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { renderShiftTaskFormHtml, type ShiftTaskFormData } from "@markiro/domain";
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
// The schema is refined (plan РЕЖ part B: the print policy), so it takes the
// missing sheet as `null` before it reads the shift rather than by `.extend`.
const parityShiftSchema = z.preprocess(
  (value) =>
    typeof value === "object" && value !== null
      ? {
          palletSheetTemplateId: null,
          // The cloud's cases have one date for a shift's day, its production date.
          plannedDate: (value as { productionDate?: unknown }).productionDate,
          ...value,
        }
      : value,
  officeShiftSchema,
);

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
        // The cloud's cases have no photo: the blank's bytes are the cloud's (plan ТОВ).
        inputs: { ...parityCase.host, photo: null },
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

// The cloud loader's input of a task case (`ShiftsService.taskFormData`), as
// `apps/api/test/standalone-forms-parity.test.ts` reads it.
const cloudTaskSchema = z.object({
  shiftId: z.string(),
  shiftNumber: z.string(),
  status: z.enum(["planned", "active"]),
  mode: z.enum(["validation", "aggregation"]),
  organizationName: z.string(),
  productId: z.string(),
  productName: z.string(),
  productPrintName: z.string().nullable(),
  gtin14: z.string(),
  imageChecksum: z.string().nullable(),
  lineName: z.string().nullable(),
  plannedDate: z.string().nullable(),
  productionDate: z.string().nullable(),
  plannedQty: z.number().int().nullable(),
  boxCapacity: z.number().int().nullable(),
  palletsEnabled: z.boolean(),
  palletBoxCapacity: z.number().int().nullable(),
  counterpartyName: z.string().nullable(),
  ssccIssuerName: z.string().nullable(),
  validationPrintMode: z.enum(["none", "duplicate_dm"]),
  validationPrintVerification: z.enum(["none", "required"]),
  allowPreviouslyAcceptedCodes: z.boolean(),
  generatedAt: z.iso.datetime(),
});
const cloudTasks = z
  .object({
    cases: z.array(
      z.union([
        z.object({ name: z.string(), form: z.literal("task"), cloud: cloudTaskSchema }),
        z.object({ name: z.string(), form: z.enum(["box", "pallet", "placard", "placards"]) }),
      ]),
    ),
  })
  .parse(read("cases.json"))
  .cases.flatMap((each) => ("cloud" in each ? [[each.name, each.cloud] as const] : []));

describe("«Бланк смены» of a validation shift, the office's and the cloud's (plan РЕЖ, A9)", () => {
  // The golden has aggregation shifts only, and the cloud's fixtures are not this plan's to
  // change; so each task case is turned into a validation shift on both sides — the host's
  // shift as the host keeps one (no pallets; the box capacity it took stays, unprinted), the
  // cloud's as its loader reads one (no box capacity, no pallets, no duplicate print) — and the
  // office must draw exactly what the cloud's renderer draws.
  it("has task cases to turn", () => {
    expect(cloudTasks.length).toBeGreaterThan(0);
  });

  it.each(cloudTasks)("%s as a validation shift", (name, cloud) => {
    const parityCase = cases.find((each) => each.name === name);
    if (parityCase?.form !== "task") throw new Error(`${name} is a task case`);
    const host = {
      ...parityCase.host,
      // The cloud's cases have no photo (plan ТОВ), as above.
      photo: null,
      shift: {
        ...parityCase.host.shift,
        mode: "validation" as const,
        palletsEnabled: false,
        palletBoxCapacity: null,
        palletTemplateId: null,
      },
    };
    const cloudData: ShiftTaskFormData = {
      ...cloud,
      mode: "validation",
      boxCapacity: null,
      palletsEnabled: false,
      palletBoxCapacity: null,
      validationPrintMode: "none",
      validationPrintVerification: "none",
      allowPreviouslyAcceptedCodes: false,
      generatedAt: new Date(cloud.generatedAt),
    };
    const drawn = renderForm({
      kind: "task",
      inputs: host,
      generatedAt: new Date(parityCase.generatedAt),
    });
    const expected = renderShiftTaskFormHtml(cloudData);
    expect(expected).toContain(`<p class="subtitle">Проверка · `);
    expect(expected).toContain("Без печати");
    expect(drawn?.kind).toBe("task");
    expect(drawn?.html).toBe(expected);
  });

  // Part B (B7): the same cases printing a duplicate, with the check required and not; the
  // host's shift carries the policy as the host answers it, the cloud's as its loader maps it.
  const printing = cloudTasks.flatMap(([name, cloud]) =>
    (["none", "required"] as const).map((verification) => [name, verification, cloud] as const),
  );
  it.each(printing)(
    "%s as a validation shift printing a duplicate, check %s",
    (name, verification, cloud) => {
      const parityCase = cases.find((each) => each.name === name);
      if (parityCase?.form !== "task") throw new Error(`${name} is a task case`);
      const host = {
        ...parityCase.host,
        photo: null,
        shift: {
          ...parityCase.host.shift,
          mode: "validation" as const,
          palletsEnabled: false,
          palletBoxCapacity: null,
          palletTemplateId: null,
          validationPrint: {
            mode: "duplicate_dm" as const,
            templateId: "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e",
            verification,
          },
        },
      };
      const cloudData: ShiftTaskFormData = {
        ...cloud,
        mode: "validation",
        boxCapacity: null,
        palletsEnabled: false,
        palletBoxCapacity: null,
        validationPrintMode: "duplicate_dm",
        validationPrintVerification: verification,
        allowPreviouslyAcceptedCodes: false,
        generatedAt: new Date(cloud.generatedAt),
      };
      const drawn = renderForm({
        kind: "task",
        inputs: host,
        generatedAt: new Date(parityCase.generatedAt),
      });
      const expected = renderShiftTaskFormHtml(cloudData);
      expect(expected).toContain("Дубликат Data Matrix");
      expect(drawn?.html).toBe(expected);
    },
  );
});
