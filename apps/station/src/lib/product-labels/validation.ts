import {
  applyProductLabelEvent,
  assertDuplicateTemplate,
  DomainError,
  duplicatePayloadDigest,
  kmHash,
  LABEL_FIELDS,
  parseDuplicateKm,
  productLabelBytesDigest,
  productLabelEventSchema,
  validationPrintPolicySchema,
} from "@markiro/domain";
import { z } from "zod";
import type { PreparedProductLabelAcceptance } from "./types.js";

const acceptanceSchema = z.strictObject({
  jobId: z.uuid(),
  shiftId: z.uuid(),
  deviceId: z.uuid(),
  terminalId: z.string().min(1),
  operatorId: z.uuid(),
  credentialOwnership: z.string().min(1),
  raw: z.string().min(1),
  canonicalRaw: z.string().min(1),
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  gtin14: z.string().regex(/^\d{14}$/),
  serial: z.string().min(1),
  acceptedAt: z.iso.datetime(),
  policy: validationPrintPolicySchema,
  fields: z.record(z.enum(LABEL_FIELDS), z.string()),
  bytesBase64: z.base64().min(4),
  preparedEvent: productLabelEventSchema,
});

function invalidAcceptance(): never {
  throw new DomainError(
    "PRODUCT_LABEL_ACCEPTANCE_INVALID",
    "Product label acceptance context is incomplete or inconsistent",
  );
}

/** All context is validated before the first physical acceptance write, also on restart reads. */
export function parseProductLabelAcceptance(input: unknown): PreparedProductLabelAcceptance {
  const result = acceptanceSchema.safeParse(input);
  if (!result.success) invalidAcceptance();
  const value = result.data;
  const { policy, preparedEvent } = value;
  if (policy.mode !== "duplicate_dm" || preparedEvent.kind !== "prepared") invalidAcceptance();
  const km = parseDuplicateKm(value.raw);
  const bytes = Uint8Array.from(atob(value.bytesBase64), (char) => char.charCodeAt(0));
  if (
    km.raw !== value.canonicalRaw ||
    kmHash(km) !== value.codeHash ||
    km.gtin14 !== value.gtin14 ||
    km.serial !== value.serial ||
    value.fields["km.code"] !== km.raw ||
    value.fields.qty !== "1" ||
    value.fields.sscc !== "" ||
    preparedEvent.jobId !== value.jobId ||
    preparedEvent.shiftId !== value.shiftId ||
    preparedEvent.codeHash !== value.codeHash ||
    preparedEvent.acceptedAt !== value.acceptedAt ||
    preparedEvent.operatorId !== value.operatorId ||
    preparedEvent.policyRevision !== policy.policyRevision ||
    preparedEvent.templateDigest !== policy.snapshot.digest ||
    preparedEvent.payloadDigest !== duplicatePayloadDigest(km.raw) ||
    preparedEvent.bytesDigest !== productLabelBytesDigest(bytes)
  )
    invalidAcceptance();
  assertDuplicateTemplate(policy.snapshot.spec);
  applyProductLabelEvent(null, preparedEvent, policy.verification);
  return { ...value, policy, preparedEvent };
}
