import { z } from "zod";
import { labelTemplateSpecSchema } from "../labels/model.js";
import { productLabelValueDigest } from "./km.js";

export const PRODUCT_LABEL_PROTOCOL = "validation-dm-duplicate-v1";
export const MAX_PRODUCT_LABEL_EVENTS = 100;

const idSchema = z.uuid().toLowerCase();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const verificationSchema = z.enum(["none", "required"]);
const printerLanguageSchema = z.enum(["zpl", "tspl"]);
const dpiSchema = z.union([z.literal(203), z.literal(300)]);
const reprintReasonSchema = z.enum(["not_printed", "damaged", "lost"]);

export type VerificationPolicy = z.infer<typeof verificationSchema>;
export type LabelTemplatePurpose = "box" | "product_duplicate" | "pallet";
export type ReprintReason = z.infer<typeof reprintReasonSchema>;
export type PrinterLanguage = z.infer<typeof printerLanguageSchema>;
export type ProductLabelAttemptState =
  "prepared" | "sending" | "sent" | "failed_before_send" | "delivery_unknown";
export type ProductLabelJobStatus =
  "prepared" | "sending" | "awaiting_verification" | "completed" | "attention";
export type VerificationOutcome = "not_required" | "pending" | "verified" | "skipped";

export const validationPrintInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({
    mode: z.literal("duplicate_dm"),
    verification: verificationSchema,
    allowPreviouslyAcceptedCodes: z.boolean().default(false),
    templateId: idSchema,
  }),
]);
export type ValidationPrintInput = z.input<typeof validationPrintInputSchema>;

const snapshotSchema = z
  .strictObject({
    id: idSchema,
    name: z.string().min(1),
    spec: labelTemplateSpecSchema,
    digest: digestSchema,
  })
  .refine(({ id, name, spec, digest }) => productLabelValueDigest({ id, name, spec }) === digest, {
    message: "Product label template digest does not match its snapshot",
    path: ["digest"],
  });
export type DuplicateTemplateSnapshot = z.infer<typeof snapshotSchema>;

export const validationPrintPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("none"),
    verification: z.literal("none"),
    templateId: z.null(),
    snapshot: z.null(),
    policyRevision: z.null(),
  }),
  z
    .strictObject({
      mode: z.literal("duplicate_dm"),
      verification: verificationSchema,
      allowPreviouslyAcceptedCodes: z.boolean().default(false),
      templateId: idSchema,
      snapshot: snapshotSchema,
      policyRevision: idSchema,
    })
    .refine((policy) => policy.templateId === policy.snapshot.id, {
      message: "Product label template does not match the policy",
      path: ["templateId"],
    }),
]);
export type ValidationPrintPolicy = z.infer<typeof validationPrintPolicySchema>;
export type EnabledValidationPrintPolicy = Extract<ValidationPrintPolicy, { mode: "duplicate_dm" }>;

const eventBaseSchema = z.strictObject({
  eventId: idSchema,
  jobId: idSchema,
  attemptId: idSchema,
  sequence: positiveIntegerSchema,
  shiftId: idSchema,
  codeHash: digestSchema,
  acceptedAt: z.iso.datetime(),
  policyRevision: idSchema,
  templateDigest: digestSchema,
  payloadDigest: digestSchema,
  operatorId: idSchema,
  occurredAt: z.iso.datetime(),
});
export type ProductLabelEventBase = z.infer<typeof eventBaseSchema>;

export const productLabelEventSchema = z.discriminatedUnion("kind", [
  eventBaseSchema
    .extend({
      kind: z.literal("prepared"),
      attemptNo: positiveIntegerSchema,
      reason: reprintReasonSchema.nullable(),
      language: printerLanguageSchema,
      dpi: dpiSchema,
      bytesDigest: digestSchema,
    })
    .refine((event) => (event.attemptNo === 1) === (event.reason === null), {
      message: "Only the initial attempt has no reprint reason",
      path: ["reason"],
    }),
  eventBaseSchema.extend({ kind: z.literal("sending") }),
  eventBaseSchema.extend({ kind: z.literal("sent") }),
  eventBaseSchema.extend({
    kind: z.literal("failed_before_send"),
    errorCode: z.enum(["printer_unconfigured", "printer_changed"]),
  }),
  eventBaseSchema.extend({
    kind: z.literal("delivery_unknown"),
    errorCode: z.enum(["transport_failed", "persistence_failed", "interrupted"]),
  }),
  eventBaseSchema.extend({ kind: z.literal("verification_skipped") }),
  eventBaseSchema.extend({ kind: z.literal("verified"), scannedPayloadDigest: digestSchema }),
  eventBaseSchema.extend({
    kind: z.literal("verification_rejected"),
    reason: z.enum(["invalid", "mismatch"]),
  }),
]);
export type ProductLabelEvent = z.infer<typeof productLabelEventSchema>;

const rejectionCodeSchema = z.enum([
  "parent_missing",
  "policy_mismatch",
  "ownership_conflict",
  "invalid_transition",
  "sequence_gap",
  "subscription_read_only",
]);
export type ProductLabelRejectionCode = z.infer<typeof rejectionCodeSchema>;
export const productLabelReceiptSchema = z
  .strictObject({
    protocol: z.literal(PRODUCT_LABEL_PROTOCOL),
    acceptedEventIds: z.array(idSchema).max(MAX_PRODUCT_LABEL_EVENTS),
    quarantined: z
      .array(z.strictObject({ eventId: idSchema, code: rejectionCodeSchema }))
      .max(MAX_PRODUCT_LABEL_EVENTS),
  })
  .refine(
    ({ acceptedEventIds, quarantined }) => {
      const ids = [...acceptedEventIds, ...quarantined.map((record) => record.eventId)];
      return ids.length <= MAX_PRODUCT_LABEL_EVENTS && new Set(ids).size === ids.length;
    },
    { message: "Receipt must contain at most 100 distinct, non-overlapping event results" },
  );
export type ProductLabelReceipt = z.infer<typeof productLabelReceiptSchema>;

export const productLabelTemplateListSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: idSchema,
      name: z.string().min(1),
      widthMm: z.number().min(10).max(300),
      heightMm: z.number().min(10).max(300),
      dpi: dpiSchema,
    }),
  ),
});
export type ProductLabelTemplateList = z.infer<typeof productLabelTemplateListSchema>;
