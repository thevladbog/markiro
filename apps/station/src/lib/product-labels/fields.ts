import { z } from "zod";
import {
  assertDuplicateTemplate,
  DomainError,
  duplicatePayloadDigest,
  kmHash,
  parseDuplicateKm,
  productLabelBytesDigest,
  validationPrintPolicySchema,
  type LabelField,
} from "@markiro/domain";
import { addCalendarDays, boxLabelFields } from "../box-label.js";
import { bytesToBase64 } from "../hardware.js";
import { renderLabelBytes } from "../print-label.js";
import { parseProductLabelAcceptance } from "./validation.js";
import type {
  DuplicateLabelFieldsInput,
  PrepareProductLabelInput,
  PreparedProductLabelAcceptance,
} from "./types.js";

export const duplicateLabelContextSchema = z.strictObject({
  productName: z.string().min(1),
  productPrintName: z.string().nullable(),
  gtin14: z.string().regex(/^\d{14}$/),
  egaisCode: z.string().nullable(),
  shelfLifeDays: z.number().int().nonnegative().nullable(),
  operatorName: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  productionDate: z
    .string()
    .refine((day) => addCalendarDays(day, 0) !== "", "Invalid production day")
    .nullable(),
  shiftNumber: z.string().nullable(),
});

export function duplicateLabelFields(input: DuplicateLabelFieldsInput): Record<LabelField, string> {
  const { canonicalRaw, acceptedAt, ...context } = input;
  const parsed = duplicateLabelContextSchema.parse(context);
  z.iso.datetime().parse(acceptedAt);
  const km = parseDuplicateKm(canonicalRaw);
  if (km.gtin14 !== parsed.gtin14)
    throw new DomainError(
      "PRODUCT_LABEL_CONTEXT_INVALID",
      "Product does not match the scanned code",
    );
  const base = boxLabelFields({ ...parsed, sscc: "", itemCount: 1, closedAt: acceptedAt });
  return { ...base, "km.code": km.raw, qty: "1", sscc: "" };
}

/** Pure preparation: the caller persists the entire result in one acceptance command. */
export async function prepareProductLabelAcceptance(
  input: PrepareProductLabelInput,
): Promise<PreparedProductLabelAcceptance> {
  const policy = validationPrintPolicySchema.parse(input.policy);
  if (policy.mode !== "duplicate_dm")
    throw new DomainError(
      "PRODUCT_LABEL_POLICY_INVALID",
      "Duplicate printing requires a template snapshot",
    );
  assertDuplicateTemplate(policy.snapshot.spec);
  if (input.printerDpi !== policy.snapshot.spec.dpi)
    throw new DomainError(
      "PRODUCT_LABEL_PRINTER_DPI_MISMATCH",
      "Configure the printer resolution to match the duplicate template",
    );
  const language = z.enum(["zpl", "tspl"]).parse(input.language);
  const km = parseDuplicateKm(input.raw);
  const fields = duplicateLabelFields({
    ...input.labelContext,
    canonicalRaw: km.raw,
    acceptedAt: input.acceptedAt,
  });
  const bytes = await renderLabelBytes(
    policy.snapshot.spec,
    fields,
    language,
    input.rasterizeText,
    { kmDataMatrix: "raster" },
  );
  const codeHash = kmHash(km);
  return parseProductLabelAcceptance({
    jobId: input.jobId,
    shiftId: input.shiftId,
    deviceId: input.deviceId,
    terminalId: input.terminalId,
    operatorId: input.operatorId,
    credentialOwnership: input.credentialOwnership,
    raw: input.raw,
    canonicalRaw: km.raw,
    codeHash,
    gtin14: km.gtin14,
    serial: km.serial,
    acceptedAt: input.acceptedAt,
    policy,
    fields,
    bytesBase64: bytesToBase64(bytes),
    preparedEvent: {
      kind: "prepared",
      eventId: input.eventId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      sequence: 1,
      shiftId: input.shiftId,
      codeHash,
      acceptedAt: input.acceptedAt,
      policyRevision: policy.policyRevision,
      templateDigest: policy.snapshot.digest,
      payloadDigest: duplicatePayloadDigest(km.raw),
      operatorId: input.operatorId,
      occurredAt: input.acceptedAt,
      attemptNo: 1,
      reason: null,
      language,
      dpi: policy.snapshot.spec.dpi,
      bytesDigest: productLabelBytesDigest(bytes),
    },
  });
}
