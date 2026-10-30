import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BoxReportData,
  PalletPlacardData,
  PalletReportData,
  ShiftTaskFormData,
} from "@markiro/domain";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CodeSearchController } from "../src/modules/code-search/code-search.controller";
import type { CodeSearchService } from "../src/modules/code-search/code-search.service";
import { boxReportQuerySchema, palletPlacardQuerySchema } from "../src/modules/code-search/dto";
import { ShiftsController } from "../src/modules/shifts/shifts.controller";
import type { ShiftsService } from "../src/modules/shifts/shifts.service";
import type { RequestWithTenant } from "../src/tenancy/tenant.guard";

/**
 * The cloud's half of the printed forms' parity between the cloud and
 * «Markiro Автоном» (plan О-Ф of `apps/standalone`). Each case of
 * `packages/domain/test/fixtures/print-forms-parity/cases.json` holds a form's
 * input as the cloud's loader returns it for some facts (`cloud`) and the
 * same facts as the standalone host answers them (`host`). Here the cloud's
 * own controllers (`CodeSearchController`, `ShiftsController.taskForm`) serve
 * the `cloud` input through their query parsing and their renderer, and the
 * HTML they answer must equal the historical `golden.json` apart from the
 * explicit approved pallet-wording corrections; the standalone office maps the
 * `host` rows and must render the same bytes
 * (`apps/standalone/test/forms-parity.test.ts`). A legitimate change of a
 * cloud form regenerates the golden from this test alone:
 * `FORMS_PARITY_WRITE=1 pnpm --filter @markiro/api exec vitest run
 * test/standalone-forms-parity.test.ts`; the standalone mapping must then
 * render the same bytes.
 */

const FIXTURES = join(__dirname, "../../../packages/domain/test/fixtures/print-forms-parity");
const TENANT = "tenant-1";
const ID = "a0000000-0000-4000-8000-000000000001";

const instant = z.iso.datetime();
const org = z.object({ name: z.string(), inn: z.string().nullable(), logo: z.null() }).strict();
const boxSchema = z
  .object({
    sscc: z.string().nullable(),
    status: z.enum(["open", "closed", "disassembled"]),
    productName: z.string().nullable(),
    org: org.nullable(),
    openedAt: instant,
    closedAt: instant.nullable(),
    disassembledAt: instant.nullable(),
    codes: z.array(
      z.object({ gtin14: z.string(), serial: z.string(), rawKm: z.string() }).strict(),
    ),
  })
  .strict();
const palletSchema = z
  .object({
    sscc: z.string().nullable(),
    status: z.enum(["open", "closed", "disassembled"]),
    productName: z.string().nullable(),
    org: org.nullable(),
    openedAt: instant,
    closedAt: instant.nullable(),
    disassembledAt: instant.nullable(),
    boxes: z.array(
      z
        .object({
          sscc: z.string().nullable(),
          codeCount: z.number().int(),
          disassembledAt: instant.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const placardSchema = z
  .object({
    sscc: z.string().nullable(),
    status: z.enum(["open", "closed", "disassembled"]),
    productName: z.string().nullable(),
    gtin14: z.string().nullable(),
    shelfLifeDays: z.number().int().nullable(),
    org: org.nullable(),
    boxes: z.array(
      z
        .object({
          productionDate: z.string().nullable(),
          codeCount: z.number().int(),
          disassembledAt: instant.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const taskSchema = z
  .object({
    shiftId: z.uuid(),
    shiftNumber: z.string(),
    status: z.enum(["planned", "active"]),
    mode: z.enum(["validation", "aggregation"]),
    organizationName: z.string(),
    productId: z.uuid(),
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
    generatedAt: instant,
  })
  .strict();
const caseSchema = z.discriminatedUnion("form", [
  z.object({ name: z.string(), form: z.literal("box"), timeZone: z.string(), cloud: boxSchema }),
  z.object({
    name: z.string(),
    form: z.literal("pallet"),
    timeZone: z.string(),
    palletId: z.uuid(),
    cloud: palletSchema,
  }),
  z.object({
    name: z.string(),
    form: z.literal("placard"),
    format: z.enum(["a4", "a5"]),
    palletId: z.uuid(),
    cloud: placardSchema,
  }),
  z.object({
    name: z.string(),
    form: z.literal("placards"),
    format: z.enum(["a4", "a5"]),
    cloud: z
      .object({ shiftNumber: z.string().nullable(), pallets: z.array(placardSchema) })
      .strict(),
  }),
  z.object({
    name: z.string(),
    form: z.literal("task"),
    generatedAt: instant,
    cloud: taskSchema,
  }),
]);
type ParityCase = z.infer<typeof caseSchema>;
const goldenSchema = z.record(
  z.string(),
  z.object({ bytes: z.number().int(), sha256: z.string(), html: z.string() }).strict(),
);
type Golden = z.infer<typeof goldenSchema>;

const cases = z
  .object({ cases: z.array(caseSchema) })
  .parse(JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8"))).cases;

/** `null` stays `null`; an ISO instant becomes the `Date` the loaders return. */
function at(value: string): Date;
function at(value: string | null): Date | null;
function at(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function boxData(data: z.infer<typeof boxSchema>): BoxReportData {
  return {
    ...data,
    openedAt: at(data.openedAt),
    closedAt: at(data.closedAt),
    disassembledAt: at(data.disassembledAt),
  };
}

function palletData(data: z.infer<typeof palletSchema>): PalletReportData {
  return {
    ...data,
    openedAt: at(data.openedAt),
    closedAt: at(data.closedAt),
    disassembledAt: at(data.disassembledAt),
    boxes: data.boxes.map((box) => ({ ...box, disassembledAt: at(box.disassembledAt) })),
  };
}

function placardData(data: z.infer<typeof placardSchema>): PalletPlacardData {
  return {
    ...data,
    boxes: data.boxes.map((box) => ({ ...box, disassembledAt: at(box.disassembledAt) })),
  };
}

function taskData(data: z.infer<typeof taskSchema>): ShiftTaskFormData {
  return { ...data, generatedAt: at(data.generatedAt) };
}

const request = { tenantId: TENANT } as RequestWithTenant;

/** The HTML the cloud's controller answers for the case, its headers checked. */
async function serve(parityCase: ParityCase): Promise<string> {
  const headers = new Map<string, string>();
  const response = {
    setHeader: (name: string, value: string) => headers.set(name, value),
  } as unknown as Response;
  let html: string;
  if (parityCase.form === "task") {
    const service = {
      taskFormData: vi.fn(async () => taskData(parityCase.cloud)),
    } as unknown as ShiftsService;
    html = await new ShiftsController(service).taskForm(request, ID, response);
  } else {
    const service = {
      boxReportData: vi.fn(async () =>
        parityCase.form === "box" ? boxData(parityCase.cloud) : undefined,
      ),
      palletReportData: vi.fn(async () =>
        parityCase.form === "pallet" ? palletData(parityCase.cloud) : undefined,
      ),
      palletPlacardData: vi.fn(async () =>
        parityCase.form === "placard" ? placardData(parityCase.cloud) : undefined,
      ),
      shiftPlacardsData: vi.fn(async () =>
        parityCase.form === "placards"
          ? {
              shiftNumber: parityCase.cloud.shiftNumber,
              pallets: parityCase.cloud.pallets.map(placardData),
            }
          : undefined,
      ),
    } as unknown as CodeSearchService;
    const controller = new CodeSearchController(service);
    switch (parityCase.form) {
      case "box":
        html = await controller.boxReport(
          request,
          ID,
          response,
          boxReportQuerySchema.parse({ timeZone: parityCase.timeZone }),
        );
        break;
      case "pallet":
        html = await controller.palletReport(
          request,
          parityCase.palletId,
          response,
          boxReportQuerySchema.parse({ timeZone: parityCase.timeZone }),
        );
        break;
      case "placard":
        html = await controller.palletPlacard(
          request,
          parityCase.palletId,
          response,
          palletPlacardQuerySchema.parse({ format: parityCase.format }),
        );
        break;
      case "placards":
        html = await controller.shiftPlacards(
          request,
          ID,
          response,
          palletPlacardQuerySchema.parse({ format: parityCase.format }),
        );
        break;
    }
  }
  expect(headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  return html;
}

/** Apply only approved pallet wording to the immutable historical HTML. */
function currentPalletWording(form: ParityCase["form"], html: string): string {
  let result = html
    .replaceAll("Состав паллеты", "Состав палета")
    .replaceAll("Ярлык паллеты", "Ярлык палета")
    .replaceAll("Ярлыки паллет", "Ярлыки палетов")
    .replaceAll("Коробов на паллете", "Коробов на палете")
    .replaceAll("Итого по паллете", "Итого по палету")
    .replaceAll("паллеты и коробов", "палета и коробов")
    .replaceAll("На паллете нет коробов", "На палете нет коробов")
    .replaceAll("Паллета</span>", "Палет</span>")
    .replaceAll("Паллета ", "Палет ")
    .replaceAll("РАСФОРМИРОВАНА", "РАСФОРМИРОВАН");
  if (form === "pallet")
    result = result
      .replaceAll("Открыта", "Открыт")
      .replaceAll("Закрыта", "Закрыт")
      .replaceAll("Расформирована", "Расформирован")
      .replaceAll("сформирована", "сформирован")
      .replaceAll("закрыта", "закрыт");
  if (form !== "task") return result;
  return result
    .replaceAll("Агрегация с паллетами", "Агрегация с палетами")
    .replaceAll("ПАЛЛЕТЫ", "ПАЛЕТЫ")
    .replaceAll(
      "Палет закрывается автоматически по достижении вместимости; закрыть её раньше",
      "Палет закрывается автоматически по достижении вместимости; закрыть его раньше",
    );
}

describe("printed forms parity with «Markiro Автоном» (plan О-Ф)", () => {
  it("the cloud's controllers answer the golden HTML for every shared case", async () => {
    const outcomes: Golden = {};
    for (const parityCase of cases) {
      const html = await serve(parityCase);
      outcomes[parityCase.name] = {
        bytes: Buffer.byteLength(html, "utf8"),
        sha256: createHash("sha256").update(html, "utf8").digest("hex"),
        html,
      };
    }
    const path = join(FIXTURES, "golden.json");
    if (process.env.FORMS_PARITY_WRITE === "1") {
      // The write mode compares the golden with itself, so it can never fail:
      // it is a developer's tool and must never be on in CI.
      if (process.env.CI) {
        throw new Error(
          "FORMS_PARITY_WRITE=1 is refused when CI is set: the golden is regenerated locally and committed",
        );
      }
      writeFileSync(path, `${JSON.stringify(outcomes, null, 2)}\n`);
    }
    const golden = goldenSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(Object.keys(golden)).toEqual(cases.map((parityCase) => parityCase.name));
    for (const parityCase of cases) {
      const frozen = golden[parityCase.name];
      if (frozen === undefined) throw new Error(`missing golden: ${parityCase.name}`);
      expect(Buffer.byteLength(frozen.html, "utf8"), parityCase.name).toBe(frozen.bytes);
      expect(createHash("sha256").update(frozen.html, "utf8").digest("hex"), parityCase.name).toBe(
        frozen.sha256,
      );
      const html = currentPalletWording(parityCase.form, frozen.html);
      expect(outcomes[parityCase.name], parityCase.name).toEqual({
        bytes: Buffer.byteLength(html, "utf8"),
        sha256: createHash("sha256").update(html, "utf8").digest("hex"),
        html,
      });
    }
  });
});
