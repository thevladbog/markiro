import { classifyScan } from "@markiro/domain";
import { z } from "zod";

import { shellActionFor } from "../../app/shell.js";
import { HostError } from "../../host/client.js";
import type { DeviceShift, DeviceShiftCreate } from "../../host/protocol.js";
import { deviceShiftCreate, type DeviceShiftInput } from "../../host/requests.js";
import type { BoxTemplateCandidate, BoxTemplateDefaults } from "../../lib/box-template-choice.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";
import type { LocalExecutor } from "../../local/executor.js";
import { copiesReady, type Pairing } from "../../local/reference-sync.js";
import { keepCreatedShift, type ShiftCopy } from "./shift-copies.js";

/** A product a station may start a shift of: in use (`active`) and not archived. */
export interface ShiftProduct {
  id: string;
  gtin14: string;
  name: string;
  chzProductGroupCode: number | null;
  boxCapacity: number | null;
  defaultBoxTemplateId: string | null;
}

/** A box template of the copies, with what decides whether it fits. */
export interface ShiftTemplate extends BoxTemplateCandidate {
  name: string;
}

/** What a new shift is chosen from: the copies of products, templates and defaults, and the site's zone. */
export interface NewShiftChoices {
  products: ShiftProduct[];
  templates: ShiftTemplate[];
  defaults: BoxTemplateDefaults;
  timeZone: string | null;
}

const productRow = z.object({
  id: z.string(),
  gtin14: z.string(),
  name: z.string(),
  chz_group_code: z.number().nullable(),
  box_capacity: z.number().nullable(),
  default_box_template_id: z.string().nullable(),
});
const templateRow = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.enum(["box", "pallet", "product_duplicate"]),
  enabled: z.number(),
  category_codes: z.string().nullable(),
});
const defaultRow = z.object({
  chz_group_code: z.number(),
  purpose: z.string(),
  template_id: z.string(),
});
const orgRow = z.object({
  time_zone: z.string(),
  default_box_template_id: z.string().nullable(),
});
const codesSchema = z.array(z.number().int());

/**
 * What a new shift is chosen from, out of this pairing's copies once a sync
 * has begun to fill them (`copiesReady`); `null` before that. Products in use
 * and not archived only, by name; box templates only (the rule of decision 7
 * reads them, `suggestBoxTemplate`), by name.
 */
export async function readNewShiftChoices(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<NewShiftChoices | null> {
  if (!(await copiesReady(local, pairing))) return null;
  const products = await local.query(
    "SELECT id, gtin14, name, chz_group_code, box_capacity, default_box_template_id " +
      "FROM ref_products WHERE status = 'active' AND archived = 0 ORDER BY name, id",
    [],
    productRow,
  );
  const templates = await local.query(
    "SELECT id, name, purpose, enabled, category_codes FROM ref_templates " +
      "WHERE purpose = 'box' ORDER BY name, id",
    [],
    templateRow,
  );
  const categories = await local.query(
    "SELECT chz_group_code, purpose, template_id FROM ref_template_defaults",
    [],
    defaultRow,
  );
  const [org] = await local.query(
    "SELECT time_zone, default_box_template_id FROM ref_org",
    [],
    orgRow,
  );
  return {
    products: products.map((row) => ({
      id: row.id,
      gtin14: row.gtin14,
      name: row.name,
      chzProductGroupCode: row.chz_group_code,
      boxCapacity: row.box_capacity,
      defaultBoxTemplateId: row.default_box_template_id,
    })),
    templates: templates.map((row) => ({
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      enabled: row.enabled === 1,
      chzProductGroupCodes:
        row.category_codes === null ? null : codesSchema.parse(JSON.parse(row.category_codes)),
    })),
    defaults: {
      defaultBoxTemplateId: org?.default_box_template_id ?? null,
      categories: categories.map((row) => ({
        chzProductGroupCode: row.chz_group_code,
        purpose: row.purpose,
        templateId: row.template_id,
      })),
    },
    timeZone: org?.time_zone ?? null,
  };
}

/** What a scan on the product step found. */
export type ProductScan =
  | { kind: "found"; product: ShiftProduct }
  | { kind: "not_found"; gtin14: string }
  | { kind: "ambiguous"; gtin14: string }
  | { kind: "not_product" };

/**
 * The product a scan names (stage 2a spec §5.7.2): its GTIN, or the GTIN of a
 * code of marking (`classifyScan`), among the products in use. An SSCC or
 * anything else is no product; a GTIN two products in use share is not
 * guessed between.
 */
export function findScannedProduct(products: readonly ShiftProduct[], raw: string): ProductScan {
  const scan = classifyScan(raw);
  const gtin14 = scan.kind === "gtin" ? scan.gtin14 : scan.kind === "km" ? scan.km.gtin14 : null;
  if (gtin14 === null) return { kind: "not_product" };
  const found = products.filter((product) => product.gtin14 === gtin14);
  const [product] = found;
  if (product === undefined) return { kind: "not_found", gtin14 };
  if (found.length > 1) return { kind: "ambiguous", gtin14 };
  return { kind: "found", product };
}

/** The box templates that fit `product`'s group (`templates::fits`), in the copies' order. */
export function fittingTemplates(
  product: ShiftProduct,
  templates: readonly ShiftTemplate[],
): ShiftTemplate[] {
  return templates.filter((template) =>
    templateFitsSlot(template, {
      purpose: "box",
      chzProductGroupCode: product.chzProductGroupCode,
    }),
  );
}

/**
 * Why the host did not create the shift: no answer (`no_link`), the product
 * was turned off or archived since the copies (`product_inactive`), the
 * template no longer fits it (`template`), another field it refused
 * (`invalid`), the station has no line (`no_line`), or anything else
 * (`failed`). A product the host does not know (`validation_failed` on
 * `productId`) is `product_inactive`, a line it does not take is `no_line`.
 */
export type CreateRefusal =
  "no_link" | "product_inactive" | "template" | "invalid" | "no_line" | "failed";

export type CreateResult =
  | { kind: "created"; shift: DeviceShift }
  | { kind: "refused"; reason: CreateRefusal }
  | { kind: "rejected"; error: unknown };

export interface CreateContext {
  local: LocalExecutor;
  pairing: Pairing;
  /** `HostApi.createDeviceShift`. */
  create: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  now: () => number;
}

/**
 * Creates the shift on the host (`POST /v1/device/shifts`) and keeps it with
 * the copies at once. The same `requestId` again answers the same shift, so a
 * retry after a lost answer makes no second one (and the answer is that first
 * shift, whatever the form says now: `isShiftOfRequest` tells). A copy this computer fails to keep is no
 * refusal: the shift is the host's, the next read of the list brings it, and
 * the entry that follows says so if this computer cannot write.
 */
export async function createStationShift(
  context: CreateContext,
  input: DeviceShiftInput,
): Promise<CreateResult> {
  let shift: DeviceShift;
  try {
    shift = await context.create(deviceShiftCreate(input));
  } catch (error) {
    if (shellActionFor(error, null) !== null) return { kind: "rejected", error };
    if (!(error instanceof HostError)) return { kind: "refused", reason: "failed" };
    if (error.kind === "transport") return { kind: "refused", reason: "no_link" };
    if (error.code === "conflict") {
      const constraint = error.details["constraint"];
      if (constraint === "product_inactive") return { kind: "refused", reason: "product_inactive" };
      if (constraint === "shift_line") return { kind: "refused", reason: "no_line" };
      return { kind: "refused", reason: "failed" };
    }
    if (error.code === "validation_failed") {
      // The product gone from the office or the station's line turned off are
      // not fields the operator can mend: they are the refusals of their own.
      if (error.field === "productId") return { kind: "refused", reason: "product_inactive" };
      if (error.field === "lineId") return { kind: "refused", reason: "no_line" };
      return { kind: "refused", reason: error.field === "boxTemplateId" ? "template" : "invalid" };
    }
    return { kind: "refused", reason: "failed" };
  }
  await keepCreatedShift(context.local, context.pairing, shift, context.now()).catch(
    () => undefined,
  );
  return { kind: "created", shift };
}

/**
 * Whether the shift the host answered is the one the form asked for. The host
 * answers a repeated request id with the FIRST shift made for it and does not
 * read the body again, so after a lost answer the answer may be a shift of
 * other fields than the form shows now.
 */
export function isShiftOfRequest(shift: DeviceShift, input: DeviceShiftInput): boolean {
  return (
    shift.productId === input.productId &&
    shift.boxTemplateId === input.boxTemplateId &&
    shift.productionDate === input.productionDate &&
    shift.boxCapacity === input.boxCapacity &&
    shift.plannedQty === input.plannedQty
  );
}

/** The copy of a shift the station has just created, to enter it at once. */
export function createdCopy(shift: DeviceShift): ShiftCopy {
  return { ...shift, localState: null, entered: false };
}
